# Architecture

Four parts and one property. The parts are the client, the contract, the mint and the
relayer. The property is that no observer can tie a funded wallet to the deposit that paid
for it.

## The parts and the trust boundary

```mermaid
flowchart TB
    subgraph client["🖥️ Client — the browser. Holds the only secret that matters."]
        app["Next.js app<br/><i>app/</i>"]
        blind["lib-blind<br/>blind · unblind · verify"]
        privy["Privy<br/>note wallets"]
        app --- blind
        app --- privy
    end

    subgraph chain["⛓️ Arc — chain ID 5042002. Public. Holds the value."]
        bm["<b>BlindMint</b><br/>deposits · claimed · mintPubkeys<br/><i>the two ledgers never meet</i>"]
        bls["BLS.sol<br/>EIP-2537 pairing check"]
        bm --- bls
    end

    subgraph cre["🔒 Chainlink CRE — the mint. Holds the signing keys, never the value."]
        direction TB
        subgraph tee["TEE enclave · cre.HandlerInTee · AWS Nitro"]
            handler["onDeposit · onSweep<br/>split · blind-sign<br/><i>no logging, ever</i>"]
            keys["mint keys<br/>5 BLS12-381 scalars"]
            keys -.->|Vault DON| handler
        end
        don["DON<br/>GenerateReport · WriteReport"]
        fwd["Forwarder"]
        handler -->|"blind sigs only"| don
        don --> fwd
    end

    relayer["📮 Relayer<br/><i>workflow/relayer</i><br/>pays the gas for a claim.<br/>Sees one note at a time."]

    app -->|"1 deposit(blindedPoints) + value"| bm
    bm -.->|"2 Deposited log"| handler
    fwd -->|"3 onReport → announce"| bm
    bm -.->|"4 Announced log"| app
    app -->|"5 one note, unblinded"| relayer
    relayer -->|"6 claim(denom, wallet, sig)"| bm
    bm -->|"7 pays the wallet"| privy

    classDef secret fill:#fde2e2,stroke:#c0392b,stroke-width:2px
    classDef public fill:#e8f4fd,stroke:#2874a6,stroke-width:2px
    class keys,blind secret
    class bm,bls public
```

**The red boxes are the two secrets.** The mint scalars live in the enclave. The blinding
factors live in the browser and the client discards them after unblinding. Nothing else in
the system needs a long-lived secret, and no single party holds both.

**⚠️ The enclave box is the claim that is not yet demonstrated.** `cre workflow simulate`
runs the handler locally and states that it is not a real TEE. Confidential Workflows is in
private beta and this account has no deploy access. In every run so far the mint key sat in
a local file. See [the mint spec](mint-spec.md#what-is-not-demonstrated).

## The flow, and where the link is cut

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant D as Depositor wallet<br/>(visible)
    participant B as BlindMint
    participant M as Enclave
    participant R as Relayer
    participant W as Note wallet<br/>(unlinked)

    Note over C: rᵢ secret · Yᵢ = H_to_G2(Aᵢ)<br/>Bᵢ = rᵢ·Yᵢ
    C->>D: sign
    D->>B: deposit([B₁..B_N]) with X USDC
    B-->>M: Deposited log fires the trigger

    rect rgb(253, 226, 226)
        Note over M: inside the enclave<br/>choose the split of mintable(X)<br/>S'ᵢ = sk_dᵢ·Bᵢ
    end

    M->>B: report → announce(id, indexes, denoms, S')
    Note over B: sum(denoms) == mintable(X)<br/>tax → treasury
    B-->>C: Announced log

    Note over C: Sᵢ = rᵢ⁻¹·S'ᵢ<br/>verify against pk_dᵢ<br/><b>discard rᵢ</b>

    rect rgb(232, 244, 253)
        Note over C,R: the link is cut here.<br/>Chain holds S' = sk·(r·Y) and S = sk·Y.<br/>Matching them needs r. Only the client had r,<br/>and the client has destroyed it.
    end

    C->>R: one note {wallet, sig}
    R->>B: claim(denom, Aᵢ, Sᵢ)
    Note over B: recompute H_to_G2(Aᵢ)<br/>e(pk, Y) == e(G1, S)<br/>claimed[Aᵢ] · totalClaimed ≤ totalAnnounced
    B->>W: pay denom
    W->>W: spends, and pays its own gas
```

The unlinkable pair is the announcement and the claim. The chain holds `S' = sk·(r·Y)` from
one and `S = sk·Y` from the other. A match between them needs `r`, and `r` no longer exists
anywhere.

On Arc the denomination is the gas token, so step 7 needs no funding transaction. That is
the reason this design works at all on Arc and would need a paymaster elsewhere.

## Why each boundary is where it is

| Boundary | What it stops |
|---|---|
| The blinding factor never leaves the browser | the mint cannot link a signature it issued to the address it pays |
| The mint holds keys and never value | a broken enclave can refuse to sign, it cannot move money |
| The contract checks `sum(denoms) == mintable(X)` | the mint cannot announce more value than the deposit holds |
| `totalClaimed <= totalAnnounced` | a mint that signs off band steals from the last honest claimant, not from the contract |
| The deposit ledger and the claim ledger share no field | there is no on-chain lookup that could rebuild the link |
| The relayer sees one note per request | a party that saw a whole batch would hold the link that blinding removed |
| The depositor never sends the claim | a depositor who claimed would put the deposit and the note in one history |

## The three implementations that must agree

```mermaid
flowchart LR
    ts["<b>lib-blind</b><br/>TypeScript<br/>blind · unblind · verify · mintable"]
    vec[("lib-blind/<br/>vectors.json")]
    sol["<b>BLS.sol</b> + <b>BlindMint</b><br/>Solidity<br/>verify · mintable"]
    go["<b>workflow/mint</b><br/>Go<br/>sign · verify · Mintable"]

    ts ==>|generates| vec
    vec ==>|read by| sol
    vec ==>|read by| go

    style vec fill:#fff3cd,stroke:#b8860b,stroke-width:3px
```

`vectors.json` is the contract between the three. Change any cryptography and regenerate
it, then run all three suites.

A disagreement between off-chain unblinding and on-chain verification shows up nowhere
else. A disagreement on `mintable` makes every announcement revert with `SumMismatch`, and
that is the only symptom.

## Where each piece lives

| Part | Path | Language |
|---|---|---|
| Blind signature library and the ladder | `lib-blind/` | TypeScript |
| Contract and the pairing check | `contracts/src/` | Solidity |
| CRE workflow, the mint and the encoding | `workflow/blindmint`, `workflow/mint`, `workflow/announce` | Go, wasip1 |
| Claim relayer | `workflow/relayer` | Go |
| Wallet frontend | `app/` | TypeScript, Next.js |
| Command line client | `cli/` | TypeScript |

Specs for each: [contract](contract-spec.md) · [mint](mint-spec.md) ·
[relayer](relayer-spec.md) · [frontend](frontend-spec.md).
