# AI attribution

## Tools

**Claude Code** (Claude Opus 5, Anthropic) was used throughout. It ran as an interactive
agent in a terminal, with access to a shell, the file system and the network.

No other AI tool contributed to this repository.

## How it was used

Claude implemented the code to the author's specification and coding standards, in
collaboration with the author. Its work covered:

- **Implementation.** The blind signature library, the contracts, the Go mint and the
  client, written against a design the author had already settled.
- **Boilerplate and scaffolding.** Project setup, build configuration, ABI plumbing, the
  EIP-2537 byte codec and the CRE project files.
- **Testing and verification.** The test suites in three languages, the shared test
  vector generator, and the runs against a local node, against `cre simulate` and against
  Arc testnet.
- **Drafts.** The README and this file.

## Review

The author reviewed every change before it was committed. Drafts were sent back and
rewritten where the design, the wording or the standards did not match.

The author also corrected the design itself during implementation. The rule that the mint
chooses the denomination split, and the check that `announce` sums to the deposit, both
came from author review rather than from the AI draft.

## Author's contribution

The protocol, the trust model and the decision to run the mint inside a TEE are the
author's, from design documents that predate this repository. The author set the coding
standards, supplied the Privy and Chainlink accounts and the Arc testnet funds, and made
the final call on every change.

## Prior work

The ancestor design is [`nozkash`](https://github.com/IvanAnishchuk/nozkash), an earlier
project by the same author. This repository takes cryptographic conventions from it and
none of its application code. The README states the boundary.
