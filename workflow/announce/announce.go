// Package announce encodes and decodes the two payloads that cross the chain boundary.
//
// It reads the deposit event of BlindMint. It writes the report that BlindMint converts
// into an announcement. The package has no TEE dependency. The tests therefore run on
// the host.
package announce

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"

	ethabi "github.com/ethereum/go-ethereum/accounts/abi"
	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/IvanAnishchuk/teecash/workflow/mint"
)

// DepositedSignature must match the event of BlindMint.
const DepositedSignature = "Deposited(uint256,address,uint256,bytes[])"

// depositedArgs are the fields that the event carries outside its topics.
var depositedArgs = mustArgs(`[
  {"name":"amount","type":"uint256"},
  {"name":"blindedPoints","type":"bytes[]"}
]`)

// reportArgs are the fields of the report. BlindMint decodes them in `onReport` and
// announces the same values.
var reportArgs = mustArgs(`[
  {"name":"id","type":"uint256"},
  {"name":"pointIndexes","type":"uint256[]"},
  {"name":"denoms","type":"uint256[]"},
  {"name":"blindSigs","type":"bytes[]"}
]`)

func mustArgs(spec string) ethabi.Arguments {
	var args ethabi.Arguments
	if err := json.Unmarshal([]byte(spec), &args); err != nil {
		panic(fmt.Sprintf("announce: bad argument spec: %v", err))
	}
	return args
}

// DepositedTopic is the first topic of the deposit event.
func DepositedTopic() []byte {
	return crypto.Keccak256([]byte(DepositedSignature))
}

// Address converts a hex address to the 20 bytes that the CRE capability expects.
func Address(address string) []byte {
	return ethcommon.HexToAddress(address).Bytes()
}

// Trim0x removes an optional "0x" prefix from a secret.
func Trim0x(s string) string {
	return strings.TrimPrefix(strings.TrimSpace(s), "0x")
}

// Deposit is one deposit event of BlindMint.
type Deposit struct {
	ID            *big.Int
	Amount        *big.Int
	BlindedPoints [][]byte
}

// DecodeDeposit reads a deposit event.
//
// The identifier is the first indexed field. It therefore sits in topic 1. The amount and
// the points sit in the data.
func DecodeDeposit(topics [][]byte, data []byte) (*Deposit, error) {
	if len(topics) < 2 {
		return nil, fmt.Errorf("announce: the log carries no deposit identifier")
	}
	values, err := depositedArgs.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("announce: the log data is not a deposit: %w", err)
	}
	amount, ok := values[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("announce: the amount has the wrong type")
	}
	points, ok := values[1].([][]byte)
	if !ok {
		return nil, fmt.Errorf("announce: the blinded points have the wrong type")
	}
	// A deposit of no points is legal. A wallet below two rungs mints nothing, so it sends
	// an empty list and the whole amount becomes tax. `Mint.Split` answers no split for it
	// and the announcement then carries no note.
	//
	// An earlier version refused the empty list here. The refusal ran before the split, so
	// the mint stopped on every melt of dust, and it stopped inside the enclave where a log
	// is forbidden. The deposit stayed pending with nothing anywhere to say why.
	return &Deposit{ID: new(big.Int).SetBytes(topics[1]), Amount: amount, BlindedPoints: points}, nil
}

// EncodeReport packs the notes for BlindMint.
func EncodeReport(id *big.Int, notes []mint.Note) ([]byte, error) {
	indexes := make([]*big.Int, len(notes))
	denoms := make([]*big.Int, len(notes))
	sigs := make([][]byte, len(notes))
	for i, n := range notes {
		indexes[i] = big.NewInt(int64(n.PointIndex))
		denoms[i] = n.Denom
		sigs[i] = n.BlindSig
	}
	packed, err := reportArgs.Pack(id, indexes, denoms, sigs)
	if err != nil {
		return nil, fmt.Errorf("announce: the report did not pack: %w", err)
	}
	return packed, nil
}

// DecodeReport reverses EncodeReport. The tests use it. BlindMint does the same work in
// Solidity.
func DecodeReport(report []byte) (id *big.Int, indexes, denoms []*big.Int, sigs [][]byte, err error) {
	values, err := reportArgs.Unpack(report)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("announce: the report did not unpack: %w", err)
	}
	return values[0].(*big.Int), values[1].([]*big.Int), values[2].([]*big.Int), values[3].([][]byte), nil
}
