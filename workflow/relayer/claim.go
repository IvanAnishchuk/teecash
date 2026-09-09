package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	ethabi "github.com/ethereum/go-ethereum/accounts/abi"
	ethcommon "github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"

	"github.com/IvanAnishchuk/teecash/workflow/mint"
)

// blindMintAbi holds the five reads and the one write that the relayer needs. The
// contract carries more. A short ABI keeps the relayer independent of the build output.
var blindMintAbi = mustABI(`[
  {"name":"dst","type":"function","stateMutability":"view",
   "inputs":[],"outputs":[{"type":"bytes"}]},
  {"name":"mintPubkeys","type":"function","stateMutability":"view",
   "inputs":[{"type":"uint256"}],"outputs":[{"type":"bytes"}]},
  {"name":"claimed","type":"function","stateMutability":"view",
   "inputs":[{"type":"address"}],"outputs":[{"type":"bool"}]},
  {"name":"totalAnnounced","type":"function","stateMutability":"view",
   "inputs":[],"outputs":[{"type":"uint256"}]},
  {"name":"totalClaimed","type":"function","stateMutability":"view",
   "inputs":[],"outputs":[{"type":"uint256"}]},
  {"name":"claim","type":"function","stateMutability":"nonpayable",
   "inputs":[{"type":"uint256"},{"type":"address"},{"type":"bytes"}],"outputs":[]}
]`)

func mustABI(spec string) ethabi.ABI {
	parsed, err := ethabi.JSON(strings.NewReader(spec))
	if err != nil {
		panic(fmt.Sprintf("relayer: bad ABI: %v", err))
	}
	return parsed
}

// rung is one denomination of the ladder and the public key that signs it.
type rung struct {
	denom  *big.Int
	pubkey []byte
}

// note is one unblinded note. The client sends the wallet and the signature only. The
// relayer derives the denomination from the key that verifies.
type note struct {
	wallet ethcommon.Address
	sig    []byte
}

// result is what the relayer answers for a note that it sent.
type result struct {
	TxHash  string `json:"txHash"`
	GasUsed uint64 `json:"gasUsed"`
	Denom   string `json:"denom"`
}

// statusError carries the HTTP status for a refusal. The handler answers with it.
type statusError struct {
	status int
	reason string
}

func (e *statusError) Error() string { return e.reason }

func refuse(status int, format string, args ...any) *statusError {
	return &statusError{status: status, reason: fmt.Sprintf(format, args...)}
}

// derive finds the denomination of a note.
//
// A denomination is the key that signed. The relayer therefore tries each rung of the
// ladder and keeps the one that verifies. The client never names a denomination, so it
// cannot name one that its signature does not carry.
//
// The ladder is short. The cost is one pairing check for each rung.
func (r *Relayer) derive(n note) (*big.Int, error) {
	for _, rg := range r.rungs {
		if mint.Verify(rg.pubkey, n.wallet.Bytes(), n.sig, r.dst) {
			return rg.denom, nil
		}
	}
	return nil, refuse(http.StatusBadRequest, "no rung of the ladder signed this note")
}

// check reads the contract state that makes a claim revert.
//
// The relayer pays for the transaction. It must therefore know that the transaction is
// good before it sends. It asks the node for state. It does not ask the node whether the
// note itself is good, because derive already answered that question with a pairing.
func (r *Relayer) check(ctx context.Context, n note, denom *big.Int) error {
	var claimed bool
	if err := r.call(ctx, &claimed, "claimed", n.wallet); err != nil {
		return err
	}
	if claimed {
		return refuse(http.StatusConflict, "the wallet already claimed")
	}

	var announced, claimedTotal *big.Int
	if err := r.call(ctx, &announced, "totalAnnounced"); err != nil {
		return err
	}
	if err := r.call(ctx, &claimedTotal, "totalClaimed"); err != nil {
		return err
	}
	// A note that passes this bound reverts. Only a mint that signs off band can make
	// one. The answer is therefore 503 and not 400. The note can be good.
	if new(big.Int).Add(claimedTotal, denom).Cmp(announced) > 0 {
		return refuse(http.StatusServiceUnavailable, "the announced bound is reached")
	}
	return nil
}

// send builds, signs and sends one claim. It waits for the receipt.
//
// Only the worker calls this method. One account has one nonce, so two claims in flight
// race. The second one replaces the first or it fails.
func (r *Relayer) send(ctx context.Context, n note, denom *big.Int) (*result, error) {
	data, err := blindMintAbi.Pack("claim", denom, n.wallet, n.sig)
	if err != nil {
		return nil, fmt.Errorf("relayer: the call did not pack: %w", err)
	}

	nonce, err := r.client.PendingNonceAt(ctx, r.from)
	if err != nil {
		return nil, fmt.Errorf("relayer: the nonce did not arrive: %w", err)
	}
	head, err := r.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("relayer: the head did not arrive: %w", err)
	}
	tip, err := r.client.SuggestGasTipCap(ctx)
	if err != nil {
		return nil, fmt.Errorf("relayer: the tip did not arrive: %w", err)
	}
	// The base fee can rise between this read and the block that holds the transaction.
	// Twice the current base fee covers that rise.
	base := new(big.Int)
	if head.BaseFee != nil {
		base.Mul(head.BaseFee, big.NewInt(2))
	}
	gas, err := r.client.EstimateGas(ctx, callMsg(r.from, r.contract, data))
	if err != nil {
		// The estimate runs the call. A revert here stops the send. The relayer
		// therefore pays nothing for a claim that fails.
		return nil, refuse(http.StatusBadRequest, "the claim does not run: %v", err)
	}

	tx := ethtypes.NewTx(&ethtypes.DynamicFeeTx{
		ChainID:   r.chainID,
		Nonce:     nonce,
		GasTipCap: tip,
		GasFeeCap: new(big.Int).Add(base, tip),
		Gas:       gas + gas/4, // a margin over the estimate
		To:        &r.contract,
		Data:      data,
	})
	signed, err := ethtypes.SignTx(tx, ethtypes.LatestSignerForChainID(r.chainID), r.key)
	if err != nil {
		return nil, fmt.Errorf("relayer: the signature failed: %w", err)
	}
	if err := r.client.SendTransaction(ctx, signed); err != nil {
		return nil, fmt.Errorf("relayer: the send failed: %w", err)
	}

	receipt, err := r.await(ctx, signed.Hash())
	if err != nil {
		return nil, err
	}
	if receipt.Status != ethtypes.ReceiptStatusSuccessful {
		return nil, fmt.Errorf("relayer: the claim reverted in %s", receipt.TxHash)
	}
	return &result{
		TxHash:  receipt.TxHash.Hex(),
		GasUsed: receipt.GasUsed,
		Denom:   denom.String(),
	}, nil
}

// await waits for one receipt.
//
// ethclient carries a wait helper. It polls without a bound and it does not stop on a
// dead node. This loop stops when the request context stops.
func (r *Relayer) await(ctx context.Context, hash ethcommon.Hash) (*ethtypes.Receipt, error) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		receipt, err := r.client.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, fmt.Errorf("relayer: the receipt did not arrive: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("relayer: the claim %s has no receipt yet: %w", hash, ctx.Err())
		case <-ticker.C:
		}
	}
}

// call runs one view function and unpacks the single return value into out.
func (r *Relayer) call(ctx context.Context, out any, name string, args ...any) error {
	data, err := blindMintAbi.Pack(name, args...)
	if err != nil {
		return fmt.Errorf("relayer: %s did not pack: %w", name, err)
	}
	raw, err := r.client.CallContract(ctx, callMsg(r.from, r.contract, data), nil)
	if err != nil {
		return fmt.Errorf("relayer: %s failed: %w", name, err)
	}
	values, err := blindMintAbi.Unpack(name, raw)
	if err != nil {
		return fmt.Errorf("relayer: %s did not unpack: %w", name, err)
	}
	if len(values) != 1 {
		return fmt.Errorf("relayer: %s returned %d values", name, len(values))
	}
	return assign(out, values[0])
}

// readLadder reads the domain tag and one public key for each rung.
//
// The contract is the source of truth. No key material sits in the configuration. A rung
// with no key is not part of this deployment and the relayer drops it.
func (r *Relayer) readLadder(ctx context.Context, ladder []*big.Int) error {
	if err := r.call(ctx, &r.dst, "dst"); err != nil {
		return err
	}
	if len(r.dst) == 0 {
		return errors.New("relayer: the contract carries no domain tag")
	}
	for _, denom := range ladder {
		var pubkey []byte
		if err := r.call(ctx, &pubkey, "mintPubkeys", denom); err != nil {
			return err
		}
		if len(pubkey) == 0 {
			continue
		}
		if len(pubkey) != mint.G1Bytes {
			return fmt.Errorf("relayer: the key for %s is %d bytes", denom, len(pubkey))
		}
		r.rungs = append(r.rungs, rung{denom: denom, pubkey: pubkey})
	}
	if len(r.rungs) == 0 {
		return errors.New("relayer: the contract carries no key of the ladder")
	}
	return nil
}

// relay runs the whole path for one note. The handler calls it.
//
// The check runs before the queue. A bad note therefore never reaches the worker. A bad
// note never delays a good one.
func (r *Relayer) relay(ctx context.Context, n note) (*result, error) {
	denom, err := r.derive(n)
	if err != nil {
		return nil, err
	}
	if err := r.check(ctx, n, denom); err != nil {
		return nil, err
	}
	return r.submit(ctx, n, denom)
}

// callMsg builds one read or one gas estimate.
func callMsg(from, to ethcommon.Address, data []byte) ethereum.CallMsg {
	return ethereum.CallMsg{From: from, To: &to, Data: data}
}

// assign copies one unpacked ABI value into out. The ABI decoder returns any. Each read
// of the relayer wants one concrete type.
func assign(out any, value any) error {
	switch dst := out.(type) {
	case *bool:
		v, ok := value.(bool)
		if !ok {
			return fmt.Errorf("relayer: the value is %T and not a bool", value)
		}
		*dst = v
	case *[]byte:
		v, ok := value.([]byte)
		if !ok {
			return fmt.Errorf("relayer: the value is %T and not bytes", value)
		}
		*dst = v
	case **big.Int:
		v, ok := value.(*big.Int)
		if !ok {
			return fmt.Errorf("relayer: the value is %T and not a number", value)
		}
		*dst = v
	default:
		return fmt.Errorf("relayer: there is no rule for %T", out)
	}
	return nil
}
