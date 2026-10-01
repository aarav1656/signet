# Chiron web DESIGN.md (v3, the gate log)

Binding for every file under `web/src`. Direction chosen from `web/mockups-dark/a.html` (headline from `c.html`).

## Art direction

Chiron is a gate log: the account's own record of what its gate let through and what it turned away. A graphite
page, a thin left rail carrying the account, one panel that reads the chain and lists every event in order.
An amber dot is a verified state. A red ring is a refusal. Nothing else on the page is coloured.

## Typefaces (two families)

- **Archivo** (`@fontsource-variable/archivo/wdth.css`, OFL), weight 400 to 600, with the width axis: headlines at
  600 and 96% width with -0.035em tracking, the wordmark at 115% width. Body 15px / 1.5.
- **IBM Plex Mono** (`@fontsource/ibm-plex-mono`, 400 and 500) for hashes, addresses, block numbers, status
  tags, section labels (11px, uppercase, +0.1em) and code identifiers. Never for prose or amounts in a headline.

## Colour (tokens in `styles.css`)

| Token | Value | Job |
|---|---|---|
| `--bg` | #121315 | the page, with one soft radial lift at the top right |
| `--panel` | #17191c | the gate log, documents, the account panel |
| `--raise` | #1d2024 | inputs, menus, the transaction panel |
| `--line` | #26292e | every hairline |
| `--ink` / `--soft` / `--mute` | #e9e7e2 / #b5b3ad / #8d9097 | text |
| `--amber` | #f2b134 | verified state: the dot, EXECUTED/APPROVED tags, the primary button, the active nav underline, the word "mandate" |
| `--red` | #ef5a4c | refusals only: the ring, the revert name, the cut in the figure, alarm rows |

An expired attestation is amber (a state that needs re-admission), never red.

## The gate log

One row per account event or reverted call, newest first: dot or ring, title, one line of provenance (model hash,
measurement, time), tag. Each row is a link to its transaction on the explorer. Events are read with bounded
`getLogs` from the deploy block; reverted calls are enumerated from the explorer index (a revert emits no log) and
decoded against the account ABI.

## Motion

One orchestrated load: headline, subline, action, glosses, then the panel, then its rows resolving in order (dot
scales in, row rises 6px). No idle or looping motion. `prefers-reduced-motion` removes all of it.

## Wallet and writes

EIP-6963 curated picker: Rabby, MetaMask, Coinbase Wallet, Phantom, only those discovered. Every write reports to
the shared transaction panel: confirm in wallet, pending with the explorer link, then confirmed or failed.
