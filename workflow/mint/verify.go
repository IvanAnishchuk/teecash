package mint

import (
	"errors"
	"fmt"

	bls12381 "github.com/consensys/gnark-crypto/ecc/bls12-381"
)

// AddressBytes is the length of a wallet address.
const AddressBytes = 20

// DecodeG1 reads a G1 point from 128 EIP-2537 bytes. It rejects a point outside the
// prime order subgroup.
func DecodeG1(in []byte) (*bls12381.G1Affine, error) {
	if len(in) != G1Bytes {
		return nil, fmt.Errorf("mint: a G1 point needs %d bytes, got %d", G1Bytes, len(in))
	}
	var p bls12381.G1Affine
	var err error
	if p.X, err = decodeFp(in[0:fpBytes]); err != nil {
		return nil, err
	}
	if p.Y, err = decodeFp(in[fpBytes:]); err != nil {
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

// HashToG2 maps a wallet address to a G2 point under one domain tag.
//
// The tag covers the chain and the contract address. The same address therefore maps to
// a different point at every other deployment. The contract runs the same map in
// Solidity at claim time. lib-blind runs it in TypeScript. All three must agree.
func HashToG2(address, dst []byte) (*bls12381.G2Affine, error) {
	if len(address) != AddressBytes {
		return nil, fmt.Errorf("mint: an address needs %d bytes, got %d", AddressBytes, len(address))
	}
	if len(dst) == 0 {
		return nil, errors.New("mint: the domain tag is empty")
	}
	p, err := bls12381.HashToG2(address, dst)
	if err != nil {
		return nil, fmt.Errorf("mint: the hash to G2 failed: %w", err)
	}
	return &p, nil
}

// Verify checks the mint signature sig over the wallet address under the domain tag dst.
//
// The condition is e(pk, H(address)) == e(G1, sig). The code checks the equivalent
// product e(-pk, H(address)) * e(G1, sig) == 1 in one pairing.
//
// BLS.verify in Solidity and verify in lib-blind must give the same answer. If this
// check and the contract disagree, the relayer pays gas for a transaction that reverts.
func Verify(pubkey, address, sig, dst []byte) bool {
	pk, err := DecodeG1(pubkey)
	if err != nil {
		return false
	}
	s, err := DecodeG2(sig)
	if err != nil {
		return false
	}
	y, err := HashToG2(address, dst)
	if err != nil {
		return false
	}

	_, _, g1, _ := bls12381.Generators()
	var negPk bls12381.G1Affine
	negPk.Neg(pk)

	ok, err := bls12381.PairingCheck([]bls12381.G1Affine{negPk, g1}, []bls12381.G2Affine{*y, *s})
	if err != nil {
		return false
	}
	return ok
}
