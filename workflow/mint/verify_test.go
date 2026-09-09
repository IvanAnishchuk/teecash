package mint

import (
	"bytes"
	"testing"
)

// The vectors carry the domain tag, the hashed point and the unblinded signature. A
// failure here means that the Go verify disagrees with the TypeScript verify and with
// BLS.verify in the contract.

func TestHashToG2MatchesVectors(t *testing.T) {
	v := load(t)
	dst := unhex(t, v.Domain.Dst)
	for i, n := range v.Notes {
		got, err := HashToG2(unhex(t, n.Address), dst)
		if err != nil {
			t.Fatalf("note %d: HashToG2: %v", i, err)
		}
		if want := unhex(t, n.HashToG2); !bytes.Equal(EncodeG2(got), want) {
			t.Errorf("note %d: the point disagrees\n got %x\nwant %x", i, EncodeG2(got), want)
		}
	}
}

func TestHashToG2RejectsBadInput(t *testing.T) {
	v := load(t)
	dst := unhex(t, v.Domain.Dst)

	if _, err := HashToG2(make([]byte, 19), dst); err == nil {
		t.Error("HashToG2 accepted a short address")
	}
	if _, err := HashToG2(make([]byte, AddressBytes), nil); err == nil {
		t.Error("HashToG2 accepted an empty domain tag")
	}
}

func TestVerifyAcceptsTheVectors(t *testing.T) {
	v := load(t)
	dst := unhex(t, v.Domain.Dst)
	for i, n := range v.Notes {
		pk := unhex(t, v.Keys[n.KeyIndex].Pk)
		if !Verify(pk, unhex(t, n.Address), unhex(t, n.Sig), dst) {
			t.Errorf("note %d: the signature does not verify", i)
		}
	}
}

// The signature binds one address, one key and one deployment. This test changes one of
// the three each time. The check must refuse each change.
func TestVerifyRejectsTheWrongInput(t *testing.T) {
	v := load(t)
	dst := unhex(t, v.Domain.Dst)
	n := v.Notes[0]
	pk := unhex(t, v.Keys[n.KeyIndex].Pk)
	address := unhex(t, n.Address)
	sig := unhex(t, n.Sig)

	if !Verify(pk, address, sig, dst) {
		t.Fatal("the good case does not verify")
	}

	other := unhex(t, n.Address)
	other[19] ^= 0x01
	if Verify(pk, other, sig, dst) {
		t.Error("Verify accepted a different address")
	}

	otherDst := unhex(t, v.Domain.Dst)
	otherDst[0] ^= 0x01
	if Verify(pk, address, sig, otherDst) {
		t.Error("Verify accepted a different domain tag")
	}

	// Every key of the ladder signs a different denomination. A note of one denomination
	// must not verify against the key of another.
	for i := range v.Keys {
		if i == n.KeyIndex {
			continue
		}
		if Verify(unhex(t, v.Keys[i].Pk), address, sig, dst) {
			t.Errorf("Verify accepted the key of denomination %s", v.Keys[i].Denom)
		}
	}

	// The blind signature is the signature before the client removes its blinding factor.
	// It must not pass the check.
	if Verify(pk, address, unhex(t, n.BlindSig), dst) {
		t.Error("Verify accepted a blind signature")
	}
}

func TestVerifyRejectsMalformedBytes(t *testing.T) {
	v := load(t)
	dst := unhex(t, v.Domain.Dst)
	n := v.Notes[0]
	pk := unhex(t, v.Keys[n.KeyIndex].Pk)
	address := unhex(t, n.Address)
	sig := unhex(t, n.Sig)

	if Verify(pk[:G1Bytes-1], address, sig, dst) {
		t.Error("Verify accepted a short public key")
	}
	if Verify(pk, address, sig[:G2Bytes-1], dst) {
		t.Error("Verify accepted a short signature")
	}
	if Verify(make([]byte, G1Bytes), address, sig, dst) {
		t.Error("Verify accepted the point at infinity as a public key")
	}
	if Verify(pk, address, make([]byte, G2Bytes), dst) {
		t.Error("Verify accepted the point at infinity as a signature")
	}

	damaged := unhex(t, n.Sig)
	damaged[200] ^= 0x01
	if Verify(pk, address, damaged, dst) {
		t.Error("Verify accepted a point off the curve")
	}

	padded := unhex(t, v.Keys[n.KeyIndex].Pk)
	padded[0] = 0x01
	if Verify(padded, address, sig, dst) {
		t.Error("Verify accepted a public key with non-zero padding")
	}
}

func TestDecodeG1MatchesEncodeG1(t *testing.T) {
	v := load(t)
	for i := range v.Keys {
		want := unhex(t, v.Keys[i].Pk)
		p, err := DecodeG1(want)
		if err != nil {
			t.Fatalf("key %d: DecodeG1: %v", i, err)
		}
		if got := EncodeG1(p); !bytes.Equal(got, want) {
			t.Errorf("key %d: the round trip disagrees\n got %x\nwant %x", i, got, want)
		}
	}
}
