// The deposit ledger of BlindMint, as the mint reads it.
//
// The mint learns about a deposit from an event. An event is a notification and not a
// record: a mint that is not running when the log arrives never learns of that deposit,
// and nothing tells it later. The ledger is the record. Deposits count from one to
// `nextId`, and each one carries its own status, so the set that still waits for the mint
// is a read and never a log search.
//
// The blinded points are the one part that the ledger does not hold. `BlindMint` never
// stores a blinded point, so they live only in the event. A catch-up therefore reads the
// ledger to learn WHICH deposits wait, and reads one log to learn WHAT to sign.
//
// This file encodes those calls. It has no TEE and no CRE dependency, so the tests run on
// the host.
package announce

import (
	"fmt"
	"math/big"

	ethabi "github.com/ethereum/go-ethereum/accounts/abi"
	ethcommon "github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Status is the state of a deposit inside BlindMint. The order matches the Solidity enum.
type Status uint8

const (
	StatusNone Status = iota
	StatusPending
	StatusAnnounced
	StatusRefunded
)

// DepositState is one row of the deposit ledger.
//
// The row carries no blinded point. `Points` is their number and not their value.
type DepositState struct {
	Depositor ethcommon.Address
	Amount    *big.Int
	Points    uint32
	Deadline  uint64
	Status    Status
}

// Waiting reports whether the mint still owes this deposit an answer.
func (d *DepositState) Waiting() bool { return d.Status == StatusPending }

var depositsReturn = mustArgs(`[
  {"name":"depositor","type":"address"},
  {"name":"amount","type":"uint96"},
  {"name":"points","type":"uint32"},
  {"name":"deadline","type":"uint64"},
  {"name":"status","type":"uint8"}
]`)

var nextIDReturn = mustArgs(`[{"name":"nextId","type":"uint256"}]`)

// selector is the first four bytes of the keccak hash of a function signature.
func selector(signature string) []byte {
	return crypto.Keccak256([]byte(signature))[:4]
}

// EncodeNextIDCall builds the calldata of `nextId()`.
//
// One deposit past the last one. The ledger holds every number below it.
func EncodeNextIDCall() []byte {
	return selector("nextId()")
}

// DecodeNextID reads the answer of `nextId()`.
func DecodeNextID(data []byte) (*big.Int, error) {
	values, err := nextIDReturn.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("announce: nextId did not unpack: %w", err)
	}
	id, ok := values[0].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("announce: nextId has the wrong type")
	}
	return id, nil
}

// EncodeDepositCall builds the calldata of `deposits(uint256)`.
func EncodeDepositCall(id *big.Int) ([]byte, error) {
	packed, err := ethabi.Arguments{{Type: uint256Type}}.Pack(id)
	if err != nil {
		return nil, fmt.Errorf("announce: the deposit identifier did not pack: %w", err)
	}
	return append(selector("deposits(uint256)"), packed...), nil
}

// DecodeDepositState reads one row of the deposit ledger.
func DecodeDepositState(data []byte) (*DepositState, error) {
	values, err := depositsReturn.Unpack(data)
	if err != nil {
		return nil, fmt.Errorf("announce: the deposit did not unpack: %w", err)
	}
	depositor, ok := values[0].(ethcommon.Address)
	if !ok {
		return nil, fmt.Errorf("announce: the depositor has the wrong type")
	}
	amount, ok := values[1].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("announce: the amount has the wrong type")
	}
	points, ok := values[2].(uint32)
	if !ok {
		return nil, fmt.Errorf("announce: the point count has the wrong type")
	}
	deadline, ok := values[3].(uint64)
	if !ok {
		return nil, fmt.Errorf("announce: the deadline has the wrong type")
	}
	status, ok := values[4].(uint8)
	if !ok {
		return nil, fmt.Errorf("announce: the status has the wrong type")
	}
	return &DepositState{
		Depositor: depositor,
		Amount:    amount,
		Points:    points,
		Deadline:  deadline,
		Status:    Status(status),
	}, nil
}

// IDTopic is the deposit identifier as the indexed topic of its event.
//
// A log search for one deposit matches on this. The search therefore returns that deposit
// and nothing else, whatever else the range holds.
func IDTopic(id *big.Int) []byte {
	return ethcommon.BigToHash(id).Bytes()
}

var uint256Type = mustType("uint256")

func mustType(name string) ethabi.Type {
	t, err := ethabi.NewType(name, "", nil)
	if err != nil {
		panic(fmt.Sprintf("announce: bad type %q: %v", name, err))
	}
	return t
}
