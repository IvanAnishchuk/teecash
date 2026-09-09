// The CRE mint.
//
// A deposit event fires the trigger. The handler runs inside a TEE. The handler reads
// the mint keys. It chooses a split. It signs the blinded points. It then crosses back
// to the DON. It writes the announcement from there.
//
// The enclave holds the mint keys. It never holds funds. A broken enclave can refuse to
// sign. It cannot move money. A signature only pays the address that it signs.
//
// The logic lives in the `mint` and `announce` packages. Neither package depends on the
// CRE runtime. Their tests therefore run on the host.
package main

import (
	"fmt"
	"log/slog"
	"math/big"

	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm"
	"github.com/smartcontractkit/cre-sdk-go/cre"

	"github.com/IvanAnishchuk/teecash/workflow/announce"
	"github.com/IvanAnishchuk/teecash/workflow/mint"
)

// Nitro in us-west-2 is the only registered TEE.
var teeRequirements = cre.OneOfTees{cre.Nitro{Regions: []cre.NitroRegion{cre.NitroUsWest2}}}

// Config comes from the workflow configuration file.
type Config struct {
	// ChainSelector names the chain of the BlindMint contract. Arc testnet is
	// 3034092155422581607. `cre workflow supported-chains` prints it.
	ChainSelector uint64 `json:"chainSelector"`
	// BlindMint emits the deposit event and receives the report.
	BlindMint string `json:"blindMint"`
	// Ladder pairs each denomination with the secret that holds its key.
	Ladder []LadderEntry `json:"ladder"`
}

// LadderEntry is one denomination and the name of its secret.
type LadderEntry struct {
	// Denom is the denomination in base units, as a decimal string.
	Denom string `json:"denom"`
	// SecretID names the secret that holds the scalar for this denomination.
	SecretID string `json:"secretId"`
}

// InitWorkflow registers the deposit handler.
func InitWorkflow(config *Config, _ *slog.Logger, _ cre.SecretsProvider) (cre.Workflow[*Config], error) {
	if len(config.Ladder) == 0 {
		return nil, fmt.Errorf("workflow: the ladder is empty")
	}
	if config.ChainSelector == 0 {
		return nil, fmt.Errorf("workflow: set chainSelector")
	}

	trigger := evm.LogTrigger(config.ChainSelector, &evm.FilterLogTriggerRequest{
		Addresses: [][]byte{announce.Address(config.BlindMint)},
		Topics:    []*evm.TopicValues{{Values: [][]byte{announce.DepositedTopic()}}},
	})
	return cre.Workflow[*Config]{
		cre.HandlerInTee(trigger, onDeposit, teeRequirements),
	}, nil
}

// onDeposit runs inside the enclave.
//
// The enclave reads the mint keys. The enclave then signs. It cannot send a transaction.
// Chain writes always run on the DON. The handler therefore crosses back with
// UsingTheDons. It writes the report from there.
//
// Never log inside this function. A log leaks timing.
func onDeposit(config *Config, runtime cre.TeeRuntime, log *evm.Log) (string, error) {
	deposit, err := announce.DecodeDeposit(log.Topics, log.Data)
	if err != nil {
		return "", err
	}

	keys, err := loadKeys(config, runtime)
	if err != nil {
		return "", err
	}
	m, err := mint.New(keys)
	if err != nil {
		return "", err
	}

	// The mint refuses a deposit that the ladder cannot express. A refund follows.
	notes, err := m.SignDeposit(deposit.Amount, deposit.BlindedPoints)
	if err != nil {
		return "", err
	}

	payload, err := announce.EncodeReport(deposit.ID, notes)
	if err != nil {
		return "", err
	}

	// Everything after this line runs on the DON. It is no longer confidential. Only the
	// blind signatures cross to the DON. A blind signature is public once announced.
	don := runtime.UsingTheDons()
	signed, err := don.GenerateReport(&cre.ReportRequest{
		EncodedPayload: payload,
		EncoderName:    "evm",
		SigningAlgo:    "ecdsa",
		HashingAlgo:    "keccak256",
	}).Await()
	if err != nil {
		return "", fmt.Errorf("workflow: the report failed: %w", err)
	}

	client := &evm.Client{ChainSelector: config.ChainSelector}
	write, err := evm.X_GeneratedCodeOnly_Wrap_WriteCreReportRequest(&evm.WriteReportRequest{
		Receiver: announce.Address(config.BlindMint),
		Report:   signed.X_GeneratedCodeOnly_Unwrap(),
	})
	if err != nil {
		return "", err
	}
	if _, err := client.WriteReport(don, write).Await(); err != nil {
		return "", fmt.Errorf("workflow: the write failed: %w", err)
	}
	return fmt.Sprintf("signed %d notes for deposit %s", len(notes), deposit.ID), nil
}

// loadKeys reads one secret for each denomination of the ladder.
//
// The CRE templates permit 11 secrets for each invocation. The ladder stops there.
func loadKeys(config *Config, runtime cre.TeeRuntime) ([]*mint.Key, error) {
	requests := make([]*cre.SecretRequest, len(config.Ladder))
	for i, entry := range config.Ladder {
		requests[i] = &cre.SecretRequest{Id: entry.SecretID}
	}
	secrets, err := runtime.GetSecrets(requests).Await()
	if err != nil {
		return nil, fmt.Errorf("workflow: the secrets did not arrive: %w", err)
	}

	keys := make([]*mint.Key, len(config.Ladder))
	for i, entry := range config.Ladder {
		denom, ok := new(big.Int).SetString(entry.Denom, 10)
		if !ok {
			return nil, fmt.Errorf("workflow: the denomination %q is not a number", entry.Denom)
		}
		sk, ok := new(big.Int).SetString(announce.Trim0x(secrets[i].Value), 16)
		if !ok {
			return nil, fmt.Errorf("workflow: the secret for %s is not hex", entry.Denom)
		}
		key, err := mint.NewKey(denom, sk)
		if err != nil {
			return nil, err
		}
		keys[i] = key
	}
	return keys, nil
}
