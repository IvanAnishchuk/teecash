// Package mint holds the signing logic of the mint. It has no CRE dependency. It
// therefore runs and tests offline.
package mint

import (
	"errors"
	"fmt"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
	"github.com/consensys/gnark-crypto/ecc/bls12-381/fp"
)

// EIP-2537 point sizes. Each coordinate takes one 64-byte word with 16 leading zero
// bytes. A G2 point puts c0 before c1.
const (
	G1Bytes = 128
	G2Bytes = 256
	fpBytes = 64
	fpPad   = 16
)

var errPadding = errors.New("mint: a field element has non-zero padding")

func encodeFp(e *fp.Element, out []byte) {
	b := e.Bytes()
	copy(out[fpPad:], b[:])
}

func decodeFp(in []byte) (fp.Element, error) {
	var e fp.Element
	for _, v := range in[:fpPad] {
		if v != 0 {
			return e, errPadding
		}
	}
	if err := e.SetBytesCanonical(in[fpPad:]); err != nil {
		return e, fmt.Errorf("mint: bad field element: %w", err)
	}
	return e, nil
}

// EncodeG1 writes a G1 point as 128 EIP-2537 bytes.
func EncodeG1(p *bls12381.G1Affine) []byte {
	out := make([]byte, G1Bytes)
	if p.IsInfinity() {
		return out
	}
	encodeFp(&p.X, out[0:fpBytes])
	encodeFp(&p.Y, out[fpBytes:])
	return out
}

// EncodeG2 writes a G2 point as 256 EIP-2537 bytes.
func EncodeG2(p *bls12381.G2Affine) []byte {
	out := make([]byte, G2Bytes)
	if p.IsInfinity() {
		return out
	}
	encodeFp(&p.X.A0, out[0:fpBytes])
	encodeFp(&p.X.A1, out[fpBytes:fpBytes*2])
	encodeFp(&p.Y.A0, out[fpBytes*2:fpBytes*3])
	encodeFp(&p.Y.A1, out[fpBytes*3:])
	return out
}

// DecodeG2 reads a G2 point from 256 EIP-2537 bytes. It rejects a point outside the
// prime order subgroup.
func DecodeG2(in []byte) (*bls12381.G2Affine, error) {
	if len(in) != G2Bytes {
		return nil, fmt.Errorf("mint: a G2 point needs %d bytes, got %d", G2Bytes, len(in))
	}
	var p bls12381.G2Affine
	var err error
	if p.X.A0, err = decodeFp(in[0:fpBytes]); err != nil {
		return nil, err
	}
	if p.X.A1, err = decodeFp(in[fpBytes : fpBytes*2]); err != nil {
		return nil, err
	}
	if p.Y.A0, err = decodeFp(in[fpBytes*2 : fpBytes*3]); err != nil {
		return nil, err
	}
	if p.Y.A1, err = decodeFp(in[fpBytes*3:]); err != nil {
		return nil, err
	}
	if p.IsInfinity() {
		return nil, errors.New("mint: the point is the point at infinity")
	}
	if !p.IsOnCurve() {
		return nil, errors.New("mint: the point is not on the curve")
	}
	if !p.IsInSubGroup() {
		return nil, errors.New("mint: the point is outside the prime order subgroup")
	}
	return &p, nil
}
