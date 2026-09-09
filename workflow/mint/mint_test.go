package mint

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"testing"
)

// The vectors that lib-blind generates. A failure here means that the Go code disagrees
// with the TypeScript code and with the Solidity code.
type vectors struct {
	Counts struct {
		Keys  int `json:"keys"`
		Notes int `json:"notes"`
	} `json:"counts"`
	Keys []struct {
		Denom string `json:"denom"`
		Sk    string `json:"sk"`
		Pk    string `json:"pk"`
	} `json:"keys"`
	Notes []struct {
		Address  string `json:"address"`
		Denom    string `json:"denom"`
		KeyIndex int    `json:"keyIndex"`
		Blinded  string `json:"blinded"`
		BlindSig string `json:"blindSig"`
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
	if v.Counts.Notes == 0 {
		t.Fatal("the vectors hold no notes")
	}
	return v
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s[2:])
	if err != nil {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return b
}

func bigFromHex(t *testing.T, s string) *big.Int {
	t.Helper()
	n, ok := new(big.Int).SetString(s[2:], 16)
	if !ok {
		t.Fatalf("bad number %q", s)
	}
	return n
}

func keyFor(t *testing.T, v vectors, i int) *Key {
	t.Helper()
	denom, ok := new(big.Int).SetString(v.Keys[i].Denom, 10)
	if !ok {
		t.Fatalf("bad denom %q", v.Keys[i].Denom)
	}
	k, err := NewKey(denom, bigFromHex(t, v.Keys[i].Sk))
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	return k
}

func TestPublicKeyMatchesVectors(t *testing.T) {
	v := load(t)
	for i := range v.Keys {
		got := keyFor(t, v, i).PublicKey()
		if want := unhex(t, v.Keys[i].Pk); !bytes.Equal(got, want) {
			t.Errorf("key %d: public key disagrees\n got %x\nwant %x", i, got, want)
		}
	}
}

func TestBlindSignMatchesVectors(t *testing.T) {
	v := load(t)
	for i, n := range v.Notes {
		got, err := keyFor(t, v, n.KeyIndex).BlindSign(unhex(t, n.Blinded))
		if err != nil {
			t.Fatalf("note %d: BlindSign: %v", i, err)
		}
		if want := unhex(t, n.BlindSig); !bytes.Equal(got, want) {
			t.Errorf("note %d: blind signature disagrees\n got %x\nwant %x", i, got, want)
		}
	}
}

func TestBlindSignRejectsBadInput(t *testing.T) {
	v := load(t)
	k := keyFor(t, v, 0)

	if _, err := k.BlindSign(make([]byte, 10)); err == nil {
		t.Error("BlindSign accepted a short point")
	}
	if _, err := k.BlindSign(make([]byte, G2Bytes)); err == nil {
		t.Error("BlindSign accepted the point at infinity")
	}

	damaged := unhex(t, v.Notes[0].Blinded)
	damaged[200] ^= 0x01
	if _, err := k.BlindSign(damaged); err == nil {
		t.Error("BlindSign accepted a point off the curve")
	}

	padded := unhex(t, v.Notes[0].Blinded)
	padded[0] = 0x01
	if _, err := k.BlindSign(padded); err == nil {
		t.Error("BlindSign accepted a point with non-zero padding")
	}
}

func newMint(t *testing.T, v vectors) *Mint {
	t.Helper()
	keys := make([]*Key, len(v.Keys))
	for i := range v.Keys {
		keys[i] = keyFor(t, v, i)
	}
	m, err := New(keys)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return m
}

func TestSplit(t *testing.T) {
	m := newMint(t, load(t))
	usdc := big.NewInt(1_000_000)

	cases := []struct {
		amount int64
		max    int
		want   []int64
	}{
		{111, 8, []int64{100, 10, 1}},
		{100, 8, []int64{100}},
		{1, 8, []int64{1}},
		{23, 8, []int64{10, 10, 1, 1, 1}},
	}
	for _, c := range cases {
		got, err := m.Split(new(big.Int).Mul(big.NewInt(c.amount), usdc), c.max)
		if err != nil {
			t.Fatalf("Split(%d): %v", c.amount, err)
		}
		if len(got) != len(c.want) {
			t.Fatalf("Split(%d): got %d notes, want %d", c.amount, len(got), len(c.want))
		}
		sum := new(big.Int)
		for i, d := range got {
			if want := new(big.Int).Mul(big.NewInt(c.want[i]), usdc); d.Cmp(want) != 0 {
				t.Errorf("Split(%d) note %d: got %s, want %s", c.amount, i, d, want)
			}
			sum.Add(sum, d)
		}
		if want := new(big.Int).Mul(big.NewInt(c.amount), usdc); sum.Cmp(want) != 0 {
			t.Errorf("Split(%d): the sum is %s", c.amount, sum)
		}
	}
}

func TestSplitRejectsTooFewPoints(t *testing.T) {
	m := newMint(t, load(t))
	amount := new(big.Int).Mul(big.NewInt(23), big.NewInt(1_000_000))
	if _, err := m.Split(amount, 2); err == nil {
		t.Error("Split accepted 2 points for a split that needs 5")
	}
}

func TestSplitRejectsARemainder(t *testing.T) {
	m := newMint(t, load(t))
	if _, err := m.Split(big.NewInt(1_500_000), 8); err == nil {
		t.Error("Split accepted an amount that the ladder cannot express")
	}
}

// SignDeposit must produce a result that the contract accepts. The denominations must
// sum to the deposit. Every point index must be distinct.
func TestSignDeposit(t *testing.T) {
	v := load(t)
	m := newMint(t, v)

	points := make([][]byte, 0, len(v.Notes)+2)
	total := new(big.Int)
	for _, n := range v.Notes {
		points = append(points, unhex(t, n.Blinded))
		d, _ := new(big.Int).SetString(n.Denom, 10)
		total.Add(total, d)
	}
	points = append(points, unhex(t, v.Notes[0].Blinded), unhex(t, v.Notes[1].Blinded))

	notes, err := m.SignDeposit(total, points)
	if err != nil {
		t.Fatalf("SignDeposit: %v", err)
	}

	sum := new(big.Int)
	seen := map[int]bool{}
	for _, n := range notes {
		if seen[n.PointIndex] {
			t.Errorf("point index %d repeats", n.PointIndex)
		}
		seen[n.PointIndex] = true
		if n.PointIndex >= len(points) {
			t.Errorf("point index %d is out of range", n.PointIndex)
		}
		if len(n.BlindSig) != G2Bytes {
			t.Errorf("point %d: the signature is %d bytes", n.PointIndex, len(n.BlindSig))
		}
		sum.Add(sum, n.Denom)
	}
	if sum.Cmp(total) != 0 {
		t.Errorf("the denominations sum to %s and the deposit is %s", sum, total)
	}
}
