// The relayer.
//
// A note wallet holds nothing until its claim lands. It cannot pay for its own claim.
// The claim must also not come from the depositor. A depositor who claims puts the
// deposit and the note in one transaction history. Blinding then buys nothing.
//
// This service sends the claim and it pays the gas. That is the whole job.
//
// It holds no note after it answers. It never sees the notes of one deposit together,
// because the client sends them one at a time. It logs no wallet, no signature and no
// denomination. A log line with an address and a time is the same leak as a batch.
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	ethcommon "github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/IvanAnishchuk/teecash/workflow/mint"
)

// oneUsdc is one USDC in native base units. The native token of Arc uses 18 decimals.
var oneUsdc = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// oneCent is one hundredth of a USDC. The ladder starts here.
var oneCent = new(big.Int).Div(oneUsdc, big.NewInt(100))

// ladder mirrors LADDER in lib-blind/src/denominations.ts.
//
// The relayer probes each rung against the contract at startup. The contract answers
// with the public key. A rung with no key is not part of the deployment. This list is
// therefore the set of rungs to ask about. The contract stays the source of truth.
//
// A rung that this list omits can never pay. The relayer finds the denomination of a note
// from the key that verifies its signature, and it only holds the keys of these rungs.
func ladder() []*big.Int {
	out := make([]*big.Int, 0, 5)
	for _, n := range []int64{1, 10} {
		out = append(out, new(big.Int).Mul(big.NewInt(n), oneCent))
	}
	for _, n := range []int64{1, 10, 100} {
		out = append(out, new(big.Int).Mul(big.NewInt(n), oneUsdc))
	}
	return out
}

// Relayer is the whole service.
type Relayer struct {
	client   *ethclient.Client
	contract ethcommon.Address
	chainID  *big.Int
	key      *ecdsa.PrivateKey
	from     ethcommon.Address

	// dst and rungs come from the contract at startup.
	dst   []byte
	rungs []rung

	// jobs carries work to the one worker. See submit.
	jobs chan *job

	requests atomic.Uint64
	failures atomic.Uint64
}

// job is one claim that waits for the worker.
type job struct {
	ctx   context.Context
	note  note
	denom *big.Int
	reply chan jobReply
}

type jobReply struct {
	result *result
	err    error
}

// submit hands one claim to the worker and waits for the answer.
//
// One account has one nonce. Two claims in flight from one account race. The second one
// replaces the first or it fails. Every send therefore goes through one worker.
// Requests queue. A claim costs about 371,000 gas the first time and about 354,000 after,
// so the queue is short in practice.
//
// This is also the reason that the service remembers nothing. The queue holds a request
// only while it runs.
func (r *Relayer) submit(ctx context.Context, n note, denom *big.Int) (*result, error) {
	j := &job{ctx: ctx, note: n, denom: denom, reply: make(chan jobReply, 1)}
	select {
	case r.jobs <- j:
	case <-ctx.Done():
		return nil, refuse(http.StatusServiceUnavailable, "the queue is full")
	}
	select {
	case reply := <-j.reply:
		return reply.result, reply.err
	case <-ctx.Done():
		return nil, refuse(http.StatusGatewayTimeout, "the claim did not finish in time")
	}
}

// worker runs every send, one at a time.
func (r *Relayer) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-r.jobs:
			res, err := r.send(j.ctx, j.note, j.denom)
			j.reply <- jobReply{result: res, err: err}
		}
	}
}

// bucket is one token bucket. The limiter holds one for each caller.
type bucket struct {
	tokens float64
	seen   time.Time
}

// limiter bounds the requests of one caller.
//
// The key is the caller. The key is never the wallet in the request. A limit keyed on
// the wallet would count the notes of one user together. That grouping is the link that
// blinding removes.
//
// A browser claims every note of one deposit in a short burst, so the burst is the size
// of one deposit. The refill then bounds sustained use.
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	burst   float64
	refill  float64 // tokens each second
	idle    time.Duration
}

func newLimiter(burst float64, refill time.Duration, idle time.Duration) *limiter {
	return &limiter{
		buckets: map[string]*bucket{},
		burst:   burst,
		refill:  1 / refill.Seconds(),
		idle:    idle,
	}
}

// allow takes one token for the caller. It reports whether a token was there.
func (l *limiter) allow(caller string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	// Drop the callers that stopped. The map would otherwise grow without a bound.
	for key, b := range l.buckets {
		if now.Sub(b.seen) > l.idle {
			delete(l.buckets, key)
		}
	}

	b, ok := l.buckets[caller]
	if !ok {
		b = &bucket{tokens: l.burst, seen: now}
		l.buckets[caller] = b
	}
	b.tokens += now.Sub(b.seen).Seconds() * l.refill
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.seen = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// claimRequest is the body of POST /claim. It carries one note.
//
// It carries no denomination. The relayer derives that from the key that verifies, so a
// client cannot name a denomination that its signature does not hold.
type claimRequest struct {
	Wallet string `json:"wallet"`
	Sig    string `json:"sig"`
}

func unhex(s string, want int) ([]byte, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(s), "0x"))
	if err != nil {
		return nil, fmt.Errorf("the value is not hex")
	}
	if len(b) != want {
		return nil, fmt.Errorf("the value is %d bytes and %d are needed", len(b), want)
	}
	return b, nil
}

// parseNote reads one note from a request body.
func parseNote(body claimRequest) (note, error) {
	wallet, err := unhex(body.Wallet, mint.AddressBytes)
	if err != nil {
		return note{}, refuse(http.StatusBadRequest, "wallet: %v", err)
	}
	sig, err := unhex(body.Sig, mint.G2Bytes)
	if err != nil {
		return note{}, refuse(http.StatusBadRequest, "sig: %v", err)
	}
	return note{wallet: ethcommon.BytesToAddress(wallet), sig: sig}, nil
}

// claimTimeout bounds one request.
//
// A request waits for the queue and then for a receipt. A node that stops answering
// would otherwise hold the request open, and the caller has no way to know that.
const claimTimeout = 90 * time.Second

// handleClaim answers POST /claim.
func (r *Relayer) handleClaim(w http.ResponseWriter, req *http.Request) {
	r.requests.Add(1)

	ctx, cancel := context.WithTimeout(req.Context(), claimTimeout)
	defer cancel()
	req = req.WithContext(ctx)

	var body claimRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, req.Body, 4096)).Decode(&body); err != nil {
		r.fail(w, refuse(http.StatusBadRequest, "the body is not the expected JSON"))
		return
	}
	n, err := parseNote(body)
	if err != nil {
		r.fail(w, err)
		return
	}

	res, err := r.relay(req.Context(), n)
	if err != nil {
		r.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// health answers GET /health. It carries no note data.
type health struct {
	ChainID  string `json:"chainId"`
	Contract string `json:"contract"`
	Relayer  string `json:"relayer"`
	Balance  string `json:"balance"`
	Rungs    int    `json:"rungs"`
	Requests uint64 `json:"requests"`
	Failures uint64 `json:"failures"`
}

func (r *Relayer) handleHealth(w http.ResponseWriter, req *http.Request) {
	balance, err := r.client.BalanceAt(req.Context(), r.from, nil)
	if err != nil {
		r.fail(w, refuse(http.StatusServiceUnavailable, "the node did not answer"))
		return
	}
	writeJSON(w, http.StatusOK, health{
		ChainID:  r.chainID.String(),
		Contract: r.contract.Hex(),
		Relayer:  r.from.Hex(),
		Balance:  balance.String(),
		Rungs:    len(r.rungs),
		Requests: r.requests.Load(),
		Failures: r.failures.Load(),
	})
}

// fail answers one refusal and counts it.
//
// The reason reaches the client and the log. A wallet, a signature and a denomination
// never reach either. Every refusal of this service names a condition and not a note.
func (r *Relayer) fail(w http.ResponseWriter, err error) {
	r.failures.Add(1)
	status := http.StatusInternalServerError
	var se *statusError
	if errors.As(err, &se) {
		status = se.status
	}
	log.Printf("refused %d: %s", status, err)
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("the answer did not send: %v", err)
	}
}

// cors answers the preflight request and it sets the origin header.
//
// The browser calls this service directly. The allowlist names the origins that may do
// so. An empty allowlist permits no origin.
func cors(origins []string, next http.Handler) http.Handler {
	permitted := map[string]bool{}
	for _, o := range origins {
		permitted[strings.TrimSpace(o)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		origin := req.Header.Get("Origin")
		if origin != "" && permitted[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			w.Header().Set("Vary", "Origin")
		}
		if req.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, req)
	})
}

// caller names the sender of a request for the rate limit.
//
// The value is the address of the peer. It is never a value from the body. It is never a
// header that the caller controls.
func caller(req *http.Request) string {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return host
}

// throttle applies the token bucket to each request.
func throttle(l *limiter, r *Relayer, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if !l.allow(caller(req), time.Now()) {
			r.fail(w, refuse(http.StatusTooManyRequests, "too many requests"))
			return
		}
		next.ServeHTTP(w, req)
	})
}

// Config is the environment of the service.
type Config struct {
	RPC      string
	Key      string
	Contract string
	Listen   string
	Origins  []string
}

func loadConfig() (*Config, error) {
	c := &Config{
		RPC:      os.Getenv("RELAYER_RPC"),
		Key:      os.Getenv("RELAYER_KEY"),
		Contract: os.Getenv("RELAYER_CONTRACT"),
		Listen:   os.Getenv("RELAYER_LISTEN"),
	}
	if c.RPC == "" {
		c.RPC = "http://127.0.0.1:8545"
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:8787"
	}
	if c.Key == "" {
		return nil, errors.New("relayer: set RELAYER_KEY")
	}
	if !ethcommon.IsHexAddress(c.Contract) {
		return nil, fmt.Errorf("relayer: RELAYER_CONTRACT %q is not an address", c.Contract)
	}
	for _, o := range strings.Split(os.Getenv("RELAYER_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.Origins = append(c.Origins, o)
		}
	}
	return c, nil
}

// New dials the node and reads the ladder from the contract.
func New(ctx context.Context, c *Config) (*Relayer, error) {
	client, err := ethclient.DialContext(ctx, c.RPC)
	if err != nil {
		return nil, fmt.Errorf("relayer: the node did not answer: %w", err)
	}
	chainID, err := client.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("relayer: the chain identifier did not arrive: %w", err)
	}
	key, err := ethcrypto.HexToECDSA(strings.TrimPrefix(strings.TrimSpace(c.Key), "0x"))
	if err != nil {
		return nil, fmt.Errorf("relayer: RELAYER_KEY is not a private key: %w", err)
	}

	r := &Relayer{
		client:   client,
		contract: ethcommon.HexToAddress(c.Contract),
		chainID:  chainID,
		key:      key,
		from:     ethcrypto.PubkeyToAddress(key.PublicKey),
		jobs:     make(chan *job, 64),
	}
	if err := r.readLadder(ctx, ladder()); err != nil {
		return nil, err
	}
	return r, nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	config, err := loadConfig()
	if err != nil {
		return err
	}
	r, err := New(ctx, config)
	if err != nil {
		return err
	}
	go r.worker(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /claim", r.handleClaim)
	mux.HandleFunc("GET /health", r.handleHealth)

	// One deposit is at most a few notes, and a browser claims them in one burst. The
	// refill then bounds sustained use.
	limit := newLimiter(8, 5*time.Second, 10*time.Minute)
	server := &http.Server{
		Addr:              config.Listen,
		Handler:           cors(config.Origins, throttle(limit, r, mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	balance, err := r.client.BalanceAt(ctx, r.from, nil)
	if err != nil {
		return fmt.Errorf("relayer: the balance did not arrive: %w", err)
	}
	log.Printf("chain %s, contract %s", r.chainID, r.contract)
	log.Printf("relayer %s holds %s", r.from, balance)
	log.Printf("the ladder carries %d rungs", len(r.rungs))
	log.Printf("listening on %s for %d origins", config.Listen, len(config.Origins))

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("the shutdown failed: %v", err)
		}
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
