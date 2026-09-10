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

	pb "github.com/smartcontractkit/chainlink-protos/cre/go/values/pb"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/blockchain/evm"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
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
	// CatchUpSchedule is the cron schedule of the sweep that finds a deposit the log
	// trigger missed. An empty value leaves the sweep off.
	CatchUpSchedule string `json:"catchUpSchedule"`
	// CatchUpBlocks bounds the log search of the sweep. The sweep reads the ledger first
	// and searches nothing when no deposit waits. Arc prunes its history and refuses a
	// wide range, so this stays well inside what the node serves.
	CatchUpBlocks uint64 `json:"catchUpBlocks"`
}

// The defaults of the sweep. A deposit that the trigger missed waits at most this long,
// and the search covers about this many blocks behind the head.
const (
	defaultCatchUpSchedule = "0 */5 * * * *"
	defaultCatchUpBlocks   = 20_000
)

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

	if config.CatchUpSchedule == "" {
		config.CatchUpSchedule = defaultCatchUpSchedule
	}
	if config.CatchUpBlocks == 0 {
		config.CatchUpBlocks = defaultCatchUpBlocks
	}

	// Two handlers answer the same question. The log trigger is the fast one and it
	// carries the work to do. The sweep is the slow one and it asks the ledger what the
	// fast one missed.
	//
	// A log trigger alone loses every deposit made while the mint was down. It holds no
	// cursor, so nothing looks for that deposit again and the money stays in the contract
	// until the depositor reclaims it. The ledger has no such gap.
	sweep := cron.Trigger(&cron.Config{Schedule: config.CatchUpSchedule})
	return cre.Workflow[*Config]{
		cre.HandlerInTee(trigger, onDeposit, teeRequirements),
		cre.HandlerInTee(sweep, onSweep, teeRequirements),
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
	return signAndAnnounce(config, runtime, deposit)
}

// onSweep runs inside the enclave on a timer.
//
// It reads the deposit ledger, and it signs every deposit that still waits. The reads and
// the write cross to the DON. Only the signing happens inside the enclave, the same as in
// onDeposit.
//
// The sweep repeats work by design. `announce` refuses a deposit that is not pending, so a
// deposit that the log trigger already answered costs one reverted write at worst, and a
// deposit that two sweeps overlap on costs the same. Nothing double mints.
//
// Never log inside this function.
func onSweep(config *Config, runtime cre.TeeRuntime, _ *cron.Payload) (string, error) {
	don := runtime.UsingTheDons()
	client := &evm.Client{ChainSelector: config.ChainSelector}

	waiting, err := waitingDeposits(config, don, client)
	if err != nil {
		return "", err
	}
	if len(waiting) == 0 {
		return "no deposit waits", nil
	}

	// Only now does the sweep touch the logs. The ledger said which deposits wait, so the
	// search runs for those and never as a standing scan of the chain.
	head, err := headBlock(don, client)
	if err != nil {
		return "", err
	}
	from := new(big.Int).Sub(head, new(big.Int).SetUint64(config.CatchUpBlocks))
	if from.Sign() < 0 {
		from = big.NewInt(0)
	}

	done := 0
	for _, id := range waiting {
		deposit, err := depositFromLog(config, don, client, id, from, head)
		if err != nil {
			// The log of this deposit is outside the range that the node still serves.
			// Its money is not lost: the depositor reclaims it after the deadline. Every
			// other deposit of this sweep still goes.
			continue
		}
		if _, err := signAndAnnounce(config, runtime, deposit); err != nil {
			continue
		}
		done++
	}
	return fmt.Sprintf("answered %d of %d waiting deposits", done, len(waiting)), nil
}

// waitingDeposits reads the ledger and returns every deposit that the mint still owes.
//
// This is the whole point of the sweep. It costs one call for the counter and one for each
// deposit, and it needs no log and no cursor.
func waitingDeposits(config *Config, don cre.Runtime, client *evm.Client) ([]*big.Int, error) {
	address := announce.Address(config.BlindMint)
	raw, err := client.CallContract(don, &evm.CallContractRequest{
		Call: &evm.CallMsg{To: address, Data: announce.EncodeNextIDCall()},
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("workflow: the deposit counter did not read: %w", err)
	}
	next, err := announce.DecodeNextID(raw.Data)
	if err != nil {
		return nil, err
	}

	var waiting []*big.Int
	for id := big.NewInt(1); id.Cmp(next) < 0; id = new(big.Int).Add(id, big.NewInt(1)) {
		data, err := announce.EncodeDepositCall(id)
		if err != nil {
			return nil, err
		}
		row, err := client.CallContract(don, &evm.CallContractRequest{
			Call: &evm.CallMsg{To: address, Data: data},
		}).Await()
		if err != nil {
			return nil, fmt.Errorf("workflow: deposit %s did not read: %w", id, err)
		}
		state, err := announce.DecodeDepositState(row.Data)
		if err != nil {
			return nil, err
		}
		if state.Waiting() {
			waiting = append(waiting, new(big.Int).Set(id))
		}
	}
	return waiting, nil
}

// headBlock reads the height of the chain.
func headBlock(don cre.Runtime, client *evm.Client) (*big.Int, error) {
	header, err := client.HeaderByNumber(don, &evm.HeaderByNumberRequest{}).Await()
	if err != nil {
		return nil, fmt.Errorf("workflow: the head did not read: %w", err)
	}
	return pb.NewIntFromBigInt(header.Header.BlockNumber), nil
}

// depositFromLog finds the deposit event of one identifier.
//
// The blinded points live only in the event, because BlindMint never stores one. The
// search matches the identifier in its own topic, so it returns this deposit alone.
func depositFromLog(
	config *Config,
	don cre.Runtime,
	client *evm.Client,
	id, from, to *big.Int,
) (*announce.Deposit, error) {
	reply, err := client.FilterLogs(don, &evm.FilterLogsRequest{
		FilterQuery: &evm.FilterQuery{
			FromBlock: pb.NewBigIntFromInt(from),
			ToBlock:   pb.NewBigIntFromInt(to),
			Addresses: [][]byte{announce.Address(config.BlindMint)},
			Topics: []*evm.Topics{
				{Topic: [][]byte{announce.DepositedTopic()}},
				{Topic: [][]byte{announce.IDTopic(id)}},
			},
		},
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("workflow: the log of deposit %s did not read: %w", id, err)
	}
	if len(reply.Logs) == 0 {
		return nil, fmt.Errorf("workflow: deposit %s has no log in the range", id)
	}
	return announce.DecodeDeposit(reply.Logs[0].Topics, reply.Logs[0].Data)
}

// signAndAnnounce signs one deposit and writes its announcement.
//
// Both handlers end here. The log trigger brings the deposit from its event and the sweep
// brings it from the ledger, and neither one changes what the mint does with it.
func signAndAnnounce(config *Config, runtime cre.TeeRuntime, deposit *announce.Deposit) (string, error) {
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

	// Only the blind signatures cross to the DON. A blind signature is public once
	// announced, so nothing confidential leaves the enclave here.
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
