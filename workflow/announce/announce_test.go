package announce

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/IvanAnishchuk/teecash/workflow/mint"
)

// The topic must match the event signature that BlindMint declares. A change to the
// event needs the same change here. The trigger does not fire otherwise.
func TestDepositedTopic(t *testing.T) {
	got := hex.EncodeToString(DepositedTopic())
	// keccak256("Deposited(uint256,address,uint256,bytes[])")
	const want = "8250d5aa73fe9a14625de5f6f0538078ffb40f93468753b4960f92d6fd1c6f6c"
	if got != want {
		t.Errorf("topic\n got %s\nwant %s", got, want)
	}
}

func TestReportRoundTrip(t *testing.T) {
	sig := bytes.Repeat([]byte{0xab}, mint.G2Bytes)
	notes := []mint.Note{
		{PointIndex: 0, Denom: big.NewInt(1_000_000), BlindSig: sig},
		{PointIndex: 2, Denom: big.NewInt(100_000_000), BlindSig: sig},
	}

	report, err := EncodeReport(big.NewInt(7), notes)
	if err != nil {
		t.Fatalf("EncodeReport: %v", err)
	}

	id, indexes, denoms, sigs, err := DecodeReport(report)
	if err != nil {
		t.Fatalf("DecodeReport: %v", err)
	}
	if id.Int64() != 7 {
		t.Errorf("id: got %s, want 7", id)
	}
	if len(indexes) != 2 || indexes[0].Int64() != 0 || indexes[1].Int64() != 2 {
		t.Errorf("indexes: got %v", indexes)
	}
	if denoms[0].Int64() != 1_000_000 || denoms[1].Int64() != 100_000_000 {
		t.Errorf("denoms: got %v", denoms)
	}
	for i, s := range sigs {
		if !bytes.Equal(s, sig) {
			t.Errorf("signature %d does not survive the round trip", i)
		}
	}
}

func TestDecodeDepositRejectsBadInput(t *testing.T) {
	if _, err := DecodeDeposit([][]byte{{0x01}}, nil); err == nil {
		t.Error("DecodeDeposit accepted a log without an identifier")
	}
	topics := [][]byte{make([]byte, 32), big.NewInt(3).FillBytes(make([]byte, 32))}
	if _, err := DecodeDeposit(topics, []byte{0x01, 0x02}); err == nil {
		t.Error("DecodeDeposit accepted data that is not a deposit")
	}
}

func TestTrim0x(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"0xdeadbeef", "deadbeef"},
		{"deadbeef", "deadbeef"},
		{"  0xdeadbeef  ", "deadbeef"},
	} {
		if got := Trim0x(c.in); got != c.want {
			t.Errorf("Trim0x(%q): got %q, want %q", c.in, got, c.want)
		}
	}
}
