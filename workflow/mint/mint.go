package mint

import (
	"errors"
	"fmt"
	"math/big"
	"sort"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

// Key is one denomination and its secret scalar. The secret stays in the enclave.
type Key struct {
	Denom *big.Int
	sk    *big.Int
}

// NewKey builds a key for one denomination.
func NewKey(denom, sk *big.Int) (*Key, error) {
	if denom == nil || denom.Sign() <= 0 {
		return nil, errors.New("mint: the denomination must be more than zero")
	}
	order := bls12381.ID.ScalarField()
	if sk == nil || sk.Sign() <= 0 || sk.Cmp(order) >= 0 {
		return nil, errors.New("mint: the secret is outside the range 1 to order-1")
	}
	return &Key{Denom: new(big.Int).Set(denom), sk: new(big.Int).Set(sk)}, nil
}

// PublicKey returns the G1 public key in 128 EIP-2537 bytes. The contract stores it.
func (k *Key) PublicKey() []byte {
	_, _, g1, _ := bls12381.Generators()
	var pk bls12381.G1Affine
	pk.ScalarMultiplication(&g1, k.sk)
	return EncodeG1(&pk)
}

// BlindSign multiplies a blinded point by the secret. The client then removes its
// blinding factor from the result.
func (k *Key) BlindSign(blinded []byte) ([]byte, error) {
	b, err := DecodeG2(blinded)
	if err != nil {
		return nil, err
	}
	var s bls12381.G2Affine
	s.ScalarMultiplication(b, k.sk)
	return EncodeG2(&s), nil
}

// Note is one signed point of an announcement.
type Note struct {
	PointIndex int
	Denom      *big.Int
	BlindSig   []byte
}

// Mint holds one key for each denomination of the ladder.
type Mint struct {
	keys   map[string]*Key
	ladder []*big.Int // largest first
	rung   *big.Int   // the smallest denomination
}

// New builds a mint from a set of keys.
func New(keys []*Key) (*Mint, error) {
	if len(keys) == 0 {
		return nil, errors.New("mint: the ladder is empty")
	}
	m := &Mint{keys: make(map[string]*Key, len(keys))}
	for _, k := range keys {
		key := k.Denom.String()
		if _, seen := m.keys[key]; seen {
			return nil, fmt.Errorf("mint: the denomination %s repeats", key)
		}
		m.keys[key] = k
		m.ladder = append(m.ladder, k.Denom)
	}
	sort.Slice(m.ladder, func(i, j int) bool { return m.ladder[i].Cmp(m.ladder[j]) > 0 })
	m.rung = m.ladder[len(m.ladder)-1]
	return m, nil
}

// Rung returns the smallest denomination. Every mint is a multiple of it.
func (m *Mint) Rung() *big.Int {
	return new(big.Int).Set(m.rung)
}

// Mintable returns the value that a deposit of amount mints.
//
// The contract keeps one rung and every base unit below the rung. That difference is the
// mint tax. The tax pays for the mint transaction and the claim transaction.
//
// The result is zero for a deposit below two rungs. That deposit mints nothing. The
// contract takes all of it.
//
// `BlindMint.mintable` and `mintable` in lib-blind must agree with this function. A
// disagreement makes every announcement revert.
func (m *Mint) Mintable(amount *big.Int) *big.Int {
	if amount == nil || amount.Cmp(m.rung) < 0 {
		return new(big.Int)
	}
	out := new(big.Int).Div(amount, m.rung)
	out.Sub(out, big.NewInt(1))
	return out.Mul(out, m.rung)
}

// PublicKeys returns the ladder and the matching public keys, largest denomination first.
func (m *Mint) PublicKeys() ([]*big.Int, [][]byte) {
	denoms := make([]*big.Int, len(m.ladder))
	pubkeys := make([][]byte, len(m.ladder))
	for i, d := range m.ladder {
		denoms[i] = d
		pubkeys[i] = m.keys[d.String()].PublicKey()
	}
	return denoms, pubkeys
}

// Split chooses the denominations for one deposit.
//
// The tax is removed first. The split therefore covers Mintable(amount) and not the whole
// deposit. An empty split is the correct answer for a deposit that mints nothing. The
// contract accepts an empty announcement for that deposit.
//
// The mint is free in its choice. The contract checks the sum and the point count only.
// This implementation takes the largest denomination that still fits. That choice gives
// the fewest notes. A later version can pick a split that makes notes harder to
// distinguish.
func (m *Mint) Split(amount *big.Int, maxPoints int) ([]*big.Int, error) {
	if amount == nil || amount.Sign() <= 0 {
		return nil, errors.New("mint: the amount must be more than zero")
	}
	// A deposit that mints nothing carries no point, and it needs none. The check for a
	// deposit with no point therefore comes after this one.
	rest := m.Mintable(amount)
	if rest.Sign() == 0 {
		return nil, nil
	}
	if maxPoints <= 0 {
		return nil, errors.New("mint: the deposit holds no points")
	}
	var out []*big.Int
	for _, d := range m.ladder {
		for rest.Cmp(d) >= 0 {
			if len(out) == maxPoints {
				return nil, fmt.Errorf("mint: the deposit holds %d points and the split needs more", maxPoints)
			}
			out = append(out, d)
			rest.Sub(rest, d)
		}
	}
	if rest.Sign() != 0 {
		return nil, fmt.Errorf("mint: the ladder cannot express a remainder of %s", rest)
	}
	return out, nil
}

// SignDeposit chooses a split and signs one point for each denomination of that split.
//
// The result feeds `announce`. The contract accepts the result only when the
// denominations sum to the deposit. Every point index must also be distinct.
func (m *Mint) SignDeposit(amount *big.Int, blindedPoints [][]byte) ([]Note, error) {
	split, err := m.Split(amount, len(blindedPoints))
	if err != nil {
		return nil, err
	}
	notes := make([]Note, len(split))
	for i, d := range split {
		sig, err := m.keys[d.String()].BlindSign(blindedPoints[i])
		if err != nil {
			return nil, fmt.Errorf("mint: point %d: %w", i, err)
		}
		notes[i] = Note{PointIndex: i, Denom: d, BlindSig: sig}
	}
	return notes, nil
}
