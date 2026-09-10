# teecash tasks.
#
# Chain configuration belongs in an env file and not on a command line. `TEECASH_ENV`
# names the file. The value is the suffix:
#
#   just status                      reads .env.local
#   TEECASH_ENV=arc just status      reads .env.arc
#
# The default is `local`. A mistake against a local anvil costs nothing. An Arc run
# spends testnet USDC. The faucet gives a limited quantity.
#
# `cli/.env` still holds the deployer key and the Privy credentials. The profile file
# holds the chain, the forwarder and the relayer only. A variable that is already in the
# environment has priority over both files.

set shell := ["bash", "-euo", "pipefail", "-c"]

profile := env_var_or_default("TEECASH_ENV", "local")
state := ".tmp/cli-state.json"

# Read the profile into the environment.
#
# `set dotenv-filename` cannot do this work. A `set` value must be a constant, and the
# profile comes from a variable. Each recipe that needs the chain therefore loads the
# file itself.
load := 'set -a && . "' + justfile_directory() / '.env.' + env_var_or_default("TEECASH_ENV", "local") + '" && set +a'

# List the tasks.
default:
    @just --list --unsorted

# ---------------------------------------------------------------------------
# Reading the profile and the deployment.
# ---------------------------------------------------------------------------

# Print the profile and the chain that the next task uses.
[group('info')]
which:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    echo "profile   {{ profile }} (.env.{{ profile }})"
    echo "rpc       ${TEECASH_RPC:-unset}"
    echo "forwarder ${TEECASH_CRE_FORWARDER:-unset}"
    echo "cre       ${CRE_TARGET:-unset}"
    echo "contract  $(jq -r '.blindMint // "not deployed"' {{ state }})"
    echo "chain     $(cast chain-id --rpc-url "$TEECASH_RPC")"

# Print the deployed address that the state file holds.
[group('info')]
contract:
    @jq -r '.blindMint // "not deployed"' {{ state }}

# Print the balance of the deployer. That account is also the treasury and the relayer.
[group('info')]
balance:
    @{{ load }} && cast balance "$(just deployer)" --rpc-url "$TEECASH_RPC" --ether

# Print the address of the deployer.
[group('info')]
deployer:
    @cast wallet address --private-key "$(just _key)"

# Print the deployer key. Every recipe that needs it reads it here, so that no key
# reaches a command line.
[private]
_key:
    @grep -oP '(?<=^TEECASH_DEPLOYER_KEY=).*' cli/.env

# ---------------------------------------------------------------------------
# Checks. These touch no chain.
# ---------------------------------------------------------------------------

# Run every suite of every implementation.
[group('check')]
test: test-lib test-contracts test-workflow test-app

[group('check')]
test-lib:
    cd lib-blind && npm test && npm run typecheck

[group('check')]
test-contracts:
    cd contracts && forge test --summary

[group('check')]
test-workflow:
    cd workflow && GOMAXPROCS=2 go test ./... -count=1

[group('check')]
test-app:
    cd app && npx tsc --noEmit && npx vitest run

# Regenerate the vectors that the three implementations share. Do this after any change
# to the crypto. Then run every suite.
[doc('Regenerate the vectors that the three implementations share.')]
[group('check')]
vectors:
    cd lib-blind && npm run vectors

# Format every language in place.
[group('check')]
fmt:
    cd contracts && forge fmt
    cd workflow && gofmt -w .

# The wasm build that the CRE workflow needs.
[group('check')]
build-wasm:
    cd workflow && GOMAXPROCS=2 GOOS=wasip1 GOARCH=wasm go build -o /dev/null ./blindmint/

# ---------------------------------------------------------------------------
# The protocol. Each task reads the profile for its chain.
# ---------------------------------------------------------------------------

# Start a local anvil that carries the chain ID of Arc.
[group('run')]
anvil:
    anvil --chain-id 5042002 --hardfork osaka --base-fee 0 --gas-price 0

# Deploy BlindMint. This resets the state file. Make a copy of that file first.
[group('run')]
deploy:
    @{{ load }} && cd cli && npm run teecash -- deploy

# Lock value against a list of blinded points. AMOUNT is what the deposit mints.
[group('run')]
deposit amount:
    @{{ load }} && cd cli && npm run teecash -- deposit {{ amount }}

# Run the mint as a service. It fires on each deposit event. It then waits again.
#
# `--broadcast` is necessary. The default of that flag is false, and the simulation then
# signs a report that it never writes. The enclave reports success and the chain shows
# no announcement. `CRE_ETH_PRIVATE_KEY` in `workflow/.env` pays for the write.
[doc('Run the mint. It fires on each deposit event and then waits again.')]
[group('run')]
mint:
    @{{ load }} && cd workflow && GOMAXPROCS=2 cre workflow simulate blindmint --target "$CRE_TARGET" --non-interactive --broadcast --listen --trigger-index 0

# Run the mint against one deposit that is already on the chain.
#
# A native value move emits an ERC-20 Transfer log. The deposit event is therefore at
# index 1. `--broadcast` is necessary for the same reason as in `mint`.
[doc('Run the mint against one deposit that is already on the chain.')]
[group('run')]
mint-once tx:
    @{{ load }} && cd workflow && GOMAXPROCS=2 cre workflow simulate blindmint --target "$CRE_TARGET" --non-interactive --broadcast --trigger-index 0 --evm-tx-hash {{ tx }} --evm-event-index 1

# Run the catch-up sweep of the mint once.
#
# The sweep is the second handler of the workflow, and in a deployment its own cron trigger
# fires it. The simulator does not run a cron trigger on a timer, so this fires it by hand.
# `--listen` cannot do it either, which the flag says itself.
#
# The sweep reads the deposit ledger and answers every deposit that still waits. It is safe
# to repeat, because announce refuses a deposit that is not pending.
[doc('Run the catch-up sweep of the mint once.')]
[group('run')]
mint-sweep:
    @{{ load }} && cd workflow && GOMAXPROCS=2 cre workflow simulate blindmint --target "$CRE_TARGET" --non-interactive --broadcast --trigger-index 1

# Print every deposit that still waits for the mint. This reads and announces nothing.
[doc('Print every deposit that still waits for the mint.')]
[group('info')]
mint-pending:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    address="$(just contract)"
    next="$(cast call "$address" 'nextId()(uint256)' --rpc-url "$TEECASH_RPC")"
    for (( id=1; id<next; id++ )); do
        read -r depositor amount points deadline status < <(
            cast call "$address" 'deposits(uint256)(address,uint256,uint256,uint256,uint8)' \
                "$id" --rpc-url "$TEECASH_RPC" --json | jq -r '[.[0], .[1], .[2], .[3], .[4]] | @tsv'
        )
        case "$status" in
            0) state="none" ;;
            1) state="PENDING" ;;
            2) state="announced" ;;
            3) state="refunded" ;;
            *) state="unknown" ;;
        esac
        echo "$id $state amount=$amount points=$points depositor=$depositor"
    done

# Run the mint on this machine. It replaces the CRE workflow for a local run. The
# forwarder must be the deployer, because this account announces directly.
[doc('Run the mint on this machine. It replaces the CRE workflow for a local run.')]
[group('run')]
mint-local id="":
    @{{ load }} && cd cli && npm run teecash -- mint {{ id }}

# Serve claims and pay their gas. The deployer key is also the relayer key.
[group('run')]
relayer:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    cd workflow && GOMAXPROCS=2 \
        RELAYER_RPC="$TEECASH_RPC" \
        RELAYER_CONTRACT="$(just contract)" \
        RELAYER_LISTEN="${RELAYER_LISTEN:-127.0.0.1:8787}" \
        RELAYER_ORIGINS="${RELAYER_ORIGINS:-}" \
        RELAYER_KEY="$(just _key)" \
        go run ./relayer/

# Report whether the relayer answers.
[group('run')]
relayer-health:
    @{{ load }} && curl -fsS "http://${RELAYER_LISTEN:-127.0.0.1:8787}/health" | jq .

# Read an announcement from the chain and unblind it.
[group('run')]
sync id="":
    @{{ load }} && cd cli && npm run teecash -- sync {{ id }}

# Claim every ready note from the deployer.
[group('run')]
claim id="":
    @{{ load }} && cd cli && npm run teecash -- claim {{ id }}

# Claim every ready note through the relayer.
[group('run')]
relay id="":
    @{{ load }} && cd cli && npm run teecash -- relay {{ id }}

# Send from one claimed note. The note pays its own gas.
[group('run')]
spend id="":
    @{{ load }} && cd cli && npm run teecash -- spend {{ id }}

# Return the value of every claimed note to the deployer. Do this after each Arc run.
[group('run')]
sweep id="":
    @{{ load }} && cd cli && npm run teecash -- sweep {{ id }}

# Print the deployment and every note.
[group('run')]
status:
    @{{ load }} && cd cli && npm run teecash -- status

# Run the whole protocol. The forwarder must be the deployer, so this is a local task.
[group('run')]
demo amount="3":
    @{{ load }} && cd cli && npm run teecash -- demo {{ amount }}

# ---------------------------------------------------------------------------
# The browser app.
# ---------------------------------------------------------------------------

# Write `app/.env.local` from the profile and the state file.
#
# Every value in that file reaches the browser bundle. None of them is a secret. The
# Privy app secret belongs to the CLI and never to the app.
#
# Do this after each deploy. A deploy changes the address, because the CREATE2 address
# covers every constructor argument.
[doc('Write app/.env.local from the profile and the state file.')]
[group('app')]
app-env:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    # Each value is read into a variable first. A command substitution inside a heredoc
    # hides its exit status from `set -e`, so a node that does not answer would write an
    # empty value and this recipe would still succeed. An empty chain ID reaches
    # `Number("")`, which is 0, and the domain tag of every note is then wrong.
    address="$(just contract)"
    if [[ "$address" == "not deployed" ]]; then
        echo "deploy first: TEECASH_ENV={{ profile }} just deploy" >&2
        exit 1
    fi
    app_id="$(grep -oP '(?<=^PRIVY_APP_ID=).*' cli/.env)"
    chain_id="$(cast chain-id --rpc-url "$TEECASH_RPC")"
    for name in app_id chain_id TEECASH_RPC; do
        if [[ -z "${!name:-}" ]]; then
            echo "app-env: $name is empty. Is the node up?" >&2
            exit 1
        fi
    done
    cat > app/.env.local <<EOF
    # Written by \`just app-env\` from .env.{{ profile }} and {{ state }}.
    NEXT_PUBLIC_PRIVY_APP_ID=$app_id
    NEXT_PUBLIC_TEECASH_CHAIN_ID=$chain_id
    NEXT_PUBLIC_TEECASH_RPC=$TEECASH_RPC
    NEXT_PUBLIC_TEECASH_CONTRACT=$address
    NEXT_PUBLIC_TEECASH_RELAYER=${TEECASH_RELAYER:-http://127.0.0.1:8787}
    NEXT_PUBLIC_TEECASH_CHAIN_NAME=${TEECASH_CHAIN_NAME:-Arc Testnet}
    EOF
    sed -i 's/^    //' app/.env.local
    echo "app/.env.local now names $address on chain $chain_id"

# Serve the app on http://localhost:3000.
#
# `TEECASH_ENV` does nothing here. Next reads `app/.env.local`, and `app-env` already
# wrote the chain and the address into that file. The banner therefore prints what the
# file names, so that a stale file is visible before the browser opens.
[doc('Serve the app on http://localhost:3000.')]
[group('app')]
app:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ ! -f app/.env.local ]]; then
        echo "run \`just app-env\` first" >&2
        exit 1
    fi
    grep -E '^NEXT_PUBLIC_TEECASH_(CHAIN_ID|CONTRACT|RPC)=' app/.env.local
    cd app && npm run dev

# Build the app for a deployment.
[group('app')]
app-build:
    cd app && npm run build

# Print every service that a full run needs. The list gives the order.
#
# The app runs against Arc. `just mint` is the CRE simulation, and the local profile leaves
# the deployer as the forwarder, so that mint announces nothing there. `just mint-local`
# answers one deposit and exits, so it is no service either. A local run is `just demo`.
[doc('Print every service that a full run needs.')]
[group('app')]
app-help:
    @echo "The app runs against Arc. Use \`just demo\` for a local run."
    @echo "Each line is one terminal. Start them in this order."
    @echo ""
    @echo "  1. TEECASH_ENV=arc just deploy"
    @echo "     Then put the address it prints in workflow/blindmint/config.production.json."
    @echo "     The trigger reads that file. An old address there mints nothing and says so"
    @echo "     nowhere. Skip this step when \`just contract\` already names a deployment,"
    @echo "     because a deploy resets .tmp/cli-state.json and that file holds every note."
    @echo "  2. TEECASH_ENV=arc just app-env"
    @echo "  3. TEECASH_ENV=arc just mint"
    @echo "  4. TEECASH_ENV=arc just relayer"
    @echo "  5. just app"
    @echo ""
    @echo "Steps 1 and 2 exit. Steps 3 to 5 continue to run."
    @echo "Step 5 needs no profile. Step 2 already wrote the chain into app/.env.local."
    @echo ""
    @echo "Then open http://localhost:3000 and not http://127.0.0.1:3000. The other"
    @echo "origin loses the HMR socket to the cross-origin guard. The first load compiles"
    @echo "the application and shows \`Loading.\` for about a minute."

# ---------------------------------------------------------------------------
# Reading the tax on the chain.
# ---------------------------------------------------------------------------

# Print the rung, the treasury and two `mintable` answers of the deployed contract.
[group('tax')]
tax-config:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    address="$(just contract)"
    echo "contract         $address"
    echo "rung             $(cast call "$address" 'rung()(uint256)' --rpc-url "$TEECASH_RPC")"
    echo "treasury         $(cast call "$address" 'treasury()(address)' --rpc-url "$TEECASH_RPC")"
    echo "mintable(3.01)   $(cast call "$address" 'mintable(uint256)(uint256)' 3010000000000000000 --rpc-url "$TEECASH_RPC")"
    echo "mintable(0.004)  $(cast call "$address" 'mintable(uint256)(uint256)' 4000000000000000 --rpc-url "$TEECASH_RPC")"

# Print every Taxed event after block FROM. Arc removes old history. Always give a
# lower block.
[doc('Print every Taxed event after block FROM.')]
[group('tax')]
tax-events from="0":
    @{{ load }} && cast logs --address "$(just contract)" 'Taxed(uint256,uint256)' --from-block {{ from }} --rpc-url "$TEECASH_RPC"

# Print the value that the contract announced and the value that it paid.
[group('tax')]
totals:
    #!/usr/bin/env bash
    set -euo pipefail
    {{ load }}
    address="$(just contract)"
    echo "totalAnnounced  $(cast call "$address" 'totalAnnounced()(uint256)' --rpc-url "$TEECASH_RPC")"
    echo "totalClaimed    $(cast call "$address" 'totalClaimed()(uint256)' --rpc-url "$TEECASH_RPC")"
    echo "balance         $(cast balance "$address" --rpc-url "$TEECASH_RPC")"
