package announce

import (
	"encoding/hex"
	"math/big"
	"testing"

	ethcommon "github.com/ethereum/go-ethereum/common"
)

// A deposit of a wallet below two rungs carries no point. The contract accepts it, the
// mint splits it into no notes, and the announcement pays the whole amount to the
// treasury as tax.
//
// An earlier decoder refused the empty list. It refused inside the enclave, where a log
// is forbidden, so every melt of dust stopped with nothing anywhere to say why. The
// deposit then stayed pending until its depositor reclaimed it, and the depositor of a
// melt is a change wallet that the melt already emptied.
func TestDecodeDepositAcceptsNoPoints(t *testing.T) {
	data, err := depositedArgs.Pack(big.NewInt(2316084999999994), [][]byte{})
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	topics := [][]byte{DepositedTopic(), IDTopic(big.NewInt(2))}

	deposit, err := DecodeDeposit(topics, data)
	if err != nil {
		t.Fatalf("DecodeDeposit refused a deposit of no points: %v", err)
	}
	if deposit.ID.Int64() != 2 {
		t.Errorf("the identifier is %s, want 2", deposit.ID)
	}
	if len(deposit.BlindedPoints) != 0 {
		t.Errorf("got %d points, want none", len(deposit.BlindedPoints))
	}
}

func TestIDTopic(t *testing.T) {
	got := hex.EncodeToString(IDTopic(big.NewInt(2)))
	const want = "0000000000000000000000000000000000000000000000000000000000000002"
	if got != want {
		t.Errorf("topic\n got %s\nwant %s", got, want)
	}
}

// The selector must match what BlindMint exposes. A wrong selector reads nothing and the
// sweep then believes that no deposit waits.
func TestCallSelectors(t *testing.T) {
	if got := hex.EncodeToString(EncodeNextIDCall()); got != "61b8ce8c" {
		t.Errorf("nextId() selector is %s, want 61b8ce8c", got)
	}
	call, err := EncodeDepositCall(big.NewInt(3))
	if err != nil {
		t.Fatalf("EncodeDepositCall: %v", err)
	}
	if len(call) != 36 {
		t.Fatalf("the calldata is %d bytes, want 36", len(call))
	}
	if got := hex.EncodeToString(call[:4]); got != "b02c43d0" {
		t.Errorf("deposits(uint256) selector is %s, want b02c43d0", got)
	}
	if got := new(big.Int).SetBytes(call[4:]).Int64(); got != 3 {
		t.Errorf("the argument is %d, want 3", got)
	}
}

// The sweep reads this row to decide whether a deposit still waits. A wrong layout would
// read a status from the wrong field and answer for every deposit.
func TestDecodeDepositState(t *testing.T) {
	want := ethcommon.HexToAddress("0x2a9A967C494E4041645f85634c1203132baf7fE0")
	data, err := depositsReturn.Pack(
		want,
		big.NewInt(2316084999999994),
		uint32(0),
		uint64(1789067331),
		uint8(StatusPending),
	)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}

	state, err := DecodeDepositState(data)
	if err != nil {
		t.Fatalf("DecodeDepositState: %v", err)
	}
	if state.Depositor != want {
		t.Errorf("the depositor is %s, want %s", state.Depositor, want)
	}
	if state.Amount.String() != "2316084999999994" {
		t.Errorf("the amount is %s", state.Amount)
	}
	if state.Points != 0 || state.Deadline != 1789067331 {
		t.Errorf("got %d points and deadline %d", state.Points, state.Deadline)
	}
	if !state.Waiting() {
		t.Error("a pending deposit must be waiting")
	}
}

func TestWaiting(t *testing.T) {
	for _, c := range []struct {
		status Status
		want   bool
	}{
		{StatusNone, false},
		{StatusPending, true},
		{StatusAnnounced, false},
		{StatusRefunded, false},
	} {
		state := &DepositState{Status: c.status}
		if got := state.Waiting(); got != c.want {
			t.Errorf("status %d: got %v, want %v", c.status, got, c.want)
		}
	}
}

func TestDecodeNextID(t *testing.T) {
	data, err := nextIDReturn.Pack(big.NewInt(4))
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	id, err := DecodeNextID(data)
	if err != nil {
		t.Fatalf("DecodeNextID: %v", err)
	}
	if id.Int64() != 4 {
		t.Errorf("nextId is %s, want 4", id)
	}
}
