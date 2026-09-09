package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	ethcommon "github.com/ethereum/go-ethereum/common"
)

// The vectors that lib-blind generates. The relayer derives a denomination from them, so
// it needs the keys, the domain tag and the unblinded signatures.
type vectors struct {
	Domain struct {
		Dst string `json:"dst"`
	} `json:"domain"`
	Keys []struct {
		Denom string `json:"denom"`
		Pk    string `json:"pk"`
	} `json:"keys"`
	Notes []struct {
		Address  string `json:"address"`
		Denom    string `json:"denom"`
		KeyIndex int    `json:"keyIndex"`
		BlindSig string `json:"blindSig"`
		Sig      string `json:"sig"`
	} `json:"notes"`
}

func load(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../lib-blind/vectors.json")
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Notes) == 0 {
		t.Fatal("the vectors hold no notes")
	}
	return v
}

func unhexOrFail(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

// fromVectors builds a relayer that holds the ladder of the vectors and no node.
//
// derive needs the ladder and the domain tag only. A test of derive therefore needs no
// chain. Every test that reads the contract is in the anvil test at the end of this file.
func fromVectors(t *testing.T, v vectors) *Relayer {
	t.Helper()
	r := &Relayer{dst: unhexOrFail(t, v.Domain.Dst)}
	for _, k := range v.Keys {
		denom, ok := new(big.Int).SetString(k.Denom, 10)
		if !ok {
			t.Fatalf("bad denom %q", k.Denom)
		}
		r.rungs = append(r.rungs, rung{denom: denom, pubkey: unhexOrFail(t, k.Pk)})
	}
	return r
}

func noteFromVector(t *testing.T, address, sig string) note {
	t.Helper()
	return note{
		wallet: ethcommon.BytesToAddress(unhexOrFail(t, address)),
		sig:    unhexOrFail(t, sig),
	}
}

// The client never names a denomination. The relayer must find the same one that the
// announcement carries. It must find it from the signature alone.
func TestDeriveFindsTheDenomination(t *testing.T) {
	v := load(t)
	r := fromVectors(t, v)
	for i, n := range v.Notes {
		got, err := r.derive(noteFromVector(t, n.Address, n.Sig))
		if err != nil {
			t.Fatalf("note %d: derive: %v", i, err)
		}
		if got.String() != n.Denom {
			t.Errorf("note %d: derived %s and the announcement says %s", i, got, n.Denom)
		}
	}
}

func TestDeriveRefusesABadNote(t *testing.T) {
	v := load(t)
	r := fromVectors(t, v)
	good := v.Notes[0]

	cases := []struct {
		name    string
		address string
		sig     string
	}{
		{"a signature that is 256 bytes too short", good.Address, "0x" + strings.Repeat("00", 512)},
		{"the point at infinity", good.Address, "0x" + strings.Repeat("00", 256)},
		{"a blind signature", good.Address, good.BlindSig},
		// The vectors use 0x11... for the first note, so this address must not be that.
		{"a good signature for another wallet", "0x" + strings.Repeat("22", 20), good.Sig},
	}
	for _, c := range cases {
		if _, err := r.derive(noteFromVector(t, c.address, c.sig)); err == nil {
			t.Errorf("derive accepted %s", c.name)
		}
	}
}

// A refusal must carry the status that the interface promises.
func TestDeriveRefusesWith400(t *testing.T) {
	v := load(t)
	r := fromVectors(t, v)
	_, err := r.derive(noteFromVector(t, v.Notes[0].Address, "0x"+strings.Repeat("00", 256)))
	se, ok := err.(*statusError)
	if !ok {
		t.Fatalf("derive returned %T and not a statusError", err)
	}
	if se.status != http.StatusBadRequest {
		t.Errorf("derive refused with %d and 400 is right", se.status)
	}
}

func TestParseNote(t *testing.T) {
	v := load(t)
	good := v.Notes[0]

	if _, err := parseNote(claimRequest{Wallet: good.Address, Sig: good.Sig}); err != nil {
		t.Fatalf("parseNote refused a good note: %v", err)
	}

	cases := []struct {
		name   string
		wallet string
		sig    string
	}{
		{"a wallet that is not hex", "0xzz", good.Sig},
		{"a short wallet", "0x1111", good.Sig},
		{"a short signature", good.Address, "0xdeadbeef"},
		{"an empty signature", good.Address, ""},
	}
	for _, c := range cases {
		if _, err := parseNote(claimRequest{Wallet: c.wallet, Sig: c.sig}); err == nil {
			t.Errorf("parseNote accepted %s", c.name)
		}
	}
}

// The relayer answers a bad note before it reads the chain. This test therefore drives
// the whole HTTP stack with no node behind it.
func TestClaimRefusesABadNoteOverHTTP(t *testing.T) {
	v := load(t)
	r := fromVectors(t, v)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /claim", r.handleClaim)
	server := httptest.NewServer(mux)
	defer server.Close()

	// The signature is the right length. The refusal must therefore come from derive and
	// not from the length check in parseNote.
	body := `{"wallet":"` + v.Notes[0].Address + `","sig":"0x` + strings.Repeat("00", 256) + `"}`
	response, err := http.Post(server.URL+"/claim", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("the answer is %d and 400 is right", response.StatusCode)
	}
	var answer map[string]string
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The reason names a condition. It never names the note.
	if strings.Contains(strings.ToLower(answer["error"]), strings.ToLower(v.Notes[0].Address)) {
		t.Error("the answer carries the wallet address")
	}
	if r.failures.Load() != 1 {
		t.Errorf("the failure count is %d and 1 is right", r.failures.Load())
	}
}

func TestClaimRefusesABodyThatIsNotJSON(t *testing.T) {
	r := &Relayer{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/claim", strings.NewReader("not json"))
	r.handleClaim(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Errorf("the answer is %d and 400 is right", recorder.Code)
	}
}

// The limit keys on the caller and never on the wallet. Two callers must not share a
// bucket, because a shared bucket would let one caller block another.
func TestLimiterKeysOnTheCaller(t *testing.T) {
	l := newLimiter(2, time.Second, time.Minute)
	now := time.Now()

	if !l.allow("10.0.0.1", now) || !l.allow("10.0.0.1", now) {
		t.Fatal("the first caller lost its burst")
	}
	if l.allow("10.0.0.1", now) {
		t.Error("the first caller passed its burst")
	}
	if !l.allow("10.0.0.2", now) {
		t.Error("the second caller shares a bucket with the first")
	}
}

func TestLimiterRefills(t *testing.T) {
	l := newLimiter(2, 5*time.Second, time.Minute)
	now := time.Now()

	l.allow("10.0.0.1", now)
	l.allow("10.0.0.1", now)
	if l.allow("10.0.0.1", now) {
		t.Fatal("the caller passed its burst")
	}
	if l.allow("10.0.0.1", now.Add(4*time.Second)) {
		t.Error("a token arrived before the refill")
	}
	if !l.allow("10.0.0.1", now.Add(6*time.Second)) {
		t.Error("the refill did not arrive")
	}
}

// The map holds one bucket for each caller. It must not grow without a bound.
func TestLimiterDropsIdleCallers(t *testing.T) {
	l := newLimiter(2, time.Second, 10*time.Minute)
	now := time.Now()

	l.allow("10.0.0.1", now)
	l.allow("10.0.0.2", now.Add(time.Minute))
	if len(l.buckets) != 2 {
		t.Fatalf("the map holds %d buckets and 2 is right", len(l.buckets))
	}
	l.allow("10.0.0.3", now.Add(30*time.Minute))
	if _, ok := l.buckets["10.0.0.1"]; ok {
		t.Error("the map kept a caller that stopped")
	}
}

func TestCorsAnswersTheAllowlistOnly(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	handler := cors([]string{"http://localhost:5173"}, next)

	cases := []struct {
		origin string
		want   string
	}{
		{"http://localhost:5173", "http://localhost:5173"},
		{"http://evil.example", ""},
		{"", ""},
	}
	for _, c := range cases {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/claim", nil)
		if c.origin != "" {
			request.Header.Set("Origin", c.origin)
		}
		handler.ServeHTTP(recorder, request)
		if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != c.want {
			t.Errorf("origin %q: the answer permits %q and %q is right", c.origin, got, c.want)
		}
	}
}

func TestCorsAnswersThePreflight(t *testing.T) {
	next := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("the preflight reached the handler")
	})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodOptions, "/claim", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	cors([]string{"http://localhost:5173"}, next).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Errorf("the preflight answered %d and 204 is right", recorder.Code)
	}
}

// caller must read the peer and never a header. A header that the caller sets would let
// one caller pass the limit under many names.
func TestCallerIgnoresHeaders(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/claim", nil)
	request.RemoteAddr = "10.0.0.1:4242"
	request.Header.Set("X-Forwarded-For", "10.9.9.9")
	if got := caller(request); got != "10.0.0.1" {
		t.Errorf("caller is %q and 10.0.0.1 is right", got)
	}
}

// The chain test.
//
// It needs a node and a deployed BlindMint. Set RELAYER_RPC and RELAYER_CONTRACT to run
// it. It reads the contract and it sends nothing. It therefore costs no gas.
//
// The send path is the one part that this test does not cover. The CLI covers it. The
// command `npm run teecash -- relay` sends every ready note of a deposit through the
// service.
func TestReadsALiveContract(t *testing.T) {
	address := os.Getenv("RELAYER_CONTRACT")
	if address == "" {
		t.Skip("set RELAYER_CONTRACT and RELAYER_RPC to run the chain test")
	}
	config := &Config{
		RPC:      os.Getenv("RELAYER_RPC"),
		Contract: address,
		// New needs a key to build the sender. This test sends nothing.
		Key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
	}
	if config.RPC == "" {
		config.RPC = "http://127.0.0.1:8545"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	r, err := New(ctx, config)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// readLadder ran inside New. The contract is the source of truth for both.
	if len(r.rungs) == 0 {
		t.Error("the contract carries no rung")
	}
	if len(r.dst) == 0 {
		t.Error("the contract carries no domain tag")
	}

	// The domain tag names this chain and this contract. A wrong tag makes every
	// signature of the deployment invalid.
	want := "TEECASH_V1_" + r.chainID.String() + "_" + strings.ToLower(r.contract.Hex())
	if !strings.HasPrefix(string(r.dst), want) {
		t.Errorf("the domain tag is %q and it must start with %q", r.dst, want)
	}

	// A wallet that never claimed must pass the check. This exercises every read that
	// the relayer makes before it sends.
	fresh := note{wallet: ethcommon.BytesToAddress(unhexOrFail(t, "0x"+strings.Repeat("ab", 20)))}
	if err := r.check(ctx, fresh, r.rungs[0].denom); err != nil {
		// A bound refusal is a real answer here. The deposit may be fully claimed.
		if se, ok := err.(*statusError); !ok || se.status != http.StatusServiceUnavailable {
			t.Errorf("check: %v", err)
		}
	}
}
