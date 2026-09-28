# Chiron web DESIGN.md (binding)

Hallmark: portal app-shell. Macrostructure copied in spirit from the
Arbitrum Portal (portal.arbitrum.io): black dApp shell, a
centred segmented pill nav in the top bar, a blue primary pill button, large
rounded panels as the unit of content instead of table rows, and a small
"UI-within-UI" stat device beside long-form copy. Secondary reference
arbitrum.io contributes the accent-inside-copy
move and the fully-pilled button language, used only where it does not
collide with the portal's own rounded-rectangle radius.

Font substitution: the portal's UI face is `unica` (tokens.json
`body.fontFamily`), a licensed font. Substitute: **Geist Variable**
(`@fontsource-variable/geist`, already an installed dependency, not added).
Geist is a neutral geometric grotesque with the same clean, low-personality
UI character unica has in the reference screenshots. One family for display
and body; hierarchy comes from weight, not a second display face, per the
portal's own signature move (see below). Mono stays **JetBrains Mono**
(`@fontsource/jetbrains-mono`, already installed) for every hash, address,
amount and block number; the portal has no sampled mono token, this is
Chiron's own convention carried over because attestation data needs it.

## First screen contract

Studied on the live portal in the `deepsurge` profile on 2026-09-29
(portal.arbitrum.io `/earn`, `/earn/opportunity/lend/0xe50f...28c8`, `/bridge`,
screenshots kept outside the repo). What the portal does as a product:

- Reading order on a single-asset page: back link, asset name plus one type tag,
  then a row of four small stat tiles (Token, Protocol, TVL, Stakers), then one
  large panel carrying the thing itself (the price chart), then three more tiles,
  then one prose panel answering the obvious question ("Where does the yield come
  from?"). The action lives in a separate ticket on the right: amount, a
  "Transaction details" key/value list, one full-width blue button.
- Density: tile labels 12px grey, values 16-18px white, 16px gaps, 20px panel
  padding. Lists are rows of rounded cards under a thin column-header row, not a
  bordered table.
- Empty and per-user state: a value the visitor does not have yet is a single
  dash in its column ("Your Holdings -"), never a zero promoted to a headline and
  never an explanation paragraph. The bridge ticket renders fully with "0" and "-"
  before a wallet exists; the only call to action is Connect Wallet.

Chiron's first screen follows that order with its own noun.

- **The one sentence (5 seconds):** an agent's payment on a live channel is
  refused onchain because the receipt names a different model than the channel
  pinned.
- **Hero object (the refusal, rendered, not described):** a panel with the
  channel 0 pinned model on the left (`meta-llama/llama-3.3-70b-instruct`,
  `channels(0).requestedModelHash` = `0x245e10b5...`), the test receipt's served
  model on the right (`verifyReceipt(...).servedModelHash` = `0x8f033fe3...`), a
  not-equal mark between them, and the verdict strip under both: "Payment
  refused: ModelMismatch", the selector `0xa407e5f7`, the block number of the
  read. Every value on it is a live `eth_call` at one pinned block:
  `Assay.redeemWithReceipt(...)` from the provider (`0x93e8...EE5A`) with the
  committed input `web/src/lib/refusal-demo.json`, `ReceiptVerifier.verifyReceipt`
  and `Assay.channels(0)`. If the call ever stops reverting, or reverts with any
  other selector, the panel says so in the error colour; it never shows a cached
  verdict.
- **Honesty line, always visible on the panel:** the receipt is
  receipt-verifier's `model_swap` test vector, signed by a test key, whose served
  model is the string `served-model`. It is offered to the live channel pinned to
  llama-3.3-70b. It is labelled "test receipt". Nothing claims a real llama call
  was swapped.
- **Ticket (right column, the portal's "Transaction details"):** the attempted
  call, `redeemWithReceipt`, with its inputs (channel, amount, caller, voucher
  signer recovered locally, receipt key) and the contract's own check order as a
  list: each check that passed before the model check, the model check that
  failed, and the checks it never reached. Primary action under it: "Open a
  pinned channel" (to `/channel`).
- **Hero number:** the block of the read. It is real and non-zero by
  construction. Deposit figures (2.00 USDG per channel, 0.00 paid) are testnet
  state and appear only lower down, in the channels list, where a zero paid
  figure is shown as a plain value in its column.
- **Below the fold, in order:** live channels (`channelCount`, then one row per
  channel: agent, provider, deposit, paid, pinned model with a zero hash labelled
  legacy, measurement, receipt-only or legacy path); registered keys
  (`signers(0x79A5...6B79)` and `receiptSigners(0x110f...aa0a)` with expiries);
  "What the attestation proves"; contract constants.

## Flows

Every page has one job. Nav order follows the story: see the refusal, work a
channel, check an attestation.

- **`/` Refusal (Overview).** Job: prove the payment gate in one screen. Reads
  only, no wallet needed. The refusal panel, the ticket, then the live channel
  and key state. Loading shows the panel frame with a pulsing verdict slot
  labelled "calling redeemWithReceipt"; an RPC failure shows the error and a
  retry button in the same slot.
- **`/channel` Channel.** Job: inspect one channel and act on it as agent or
  provider. Channel picker as a segmented control built from `channelCount`
  (plus a free id field), stat tiles (deposit, paid, remaining, path, status),
  detail list and receipt redemptions on the left, the "Open a channel" ticket
  on the right, then sign voucher, redeem, close as numbered steps because their
  order matters. Every write path, ABI call and error map is unchanged.
- **`/verify` Verify.** Job: take a provider from a fresh TDX quote to
  `register`. Three numbered steps (nonce, report, dry run) because the
  contract enforces that order, with the reading-on device beside the title.
  Unchanged calls: `nextRegisterNonce`, `Verifier.verify` via eth_call,
  `simulateContract(register)`.
- **Wallet.** Connect Wallet in the top bar on every route, as on the portal.
  Before a wallet exists, per-user values are a dash and write buttons are
  disabled with the reason beside them.

## Tokens

```
--bg:           #000000  (arbitrum-portal tokens.json body.background, rgb(0,0,0))
--bg-raise:     #0F0F0F  (arbitrum-portal tokens.json elements.a.backgroundColor,
                          rgb(15,15,15), the portal's secondary pill/link surface)
--bg-sunken:    #1A1C1D  (arbitrum-portal tokens.json colorHistogram.background,
                          rgb(26,28,29), its most frequent non-black tile)
--line:         #232527  (derived: bg-sunken +2 steps lightness; hairline
                          separators, not directly sampled)
--line-strong:  #363636  (arbitrum-portal tokens.json rootCustomProperties
                          --apkt-colors-neutrals800)
--fg:           #FFFFFF  (arbitrum-portal tokens.json body.color)
--muted:        #9A9A9A  (arbitrum-portal tokens.json rootCustomProperties
                          --apkt-colors-neutrals500)
--dim:          #8A8A8A  (derived: arbitrum-portal --apkt-colors-neutrals600
                          #6C6C6C lifted until small text clears WCAG 4.5:1 on
                          --bg-raise and --bg-sunken; #6C6C6C measured 3.7:1)
--accent:       #325EE6  (arbitrum-portal tokens.json elements.button.backgroundColor,
                          rgb(50,94,230), the portal's own primary-CTA blue,
                          reused here as Chiron's action colour, not a brand mark)
--accent-hover: #4B74F0  (derived: accent +12% lightness)
--accent-ink:   #FFFFFF  (arbitrum-portal tokens.json elements.button.color)
--ok:           #34D399  (semantic verified colour; no success token was
                          sampled from either reference, kept from prior pass)
--bad:          #DF4A34  (arbitrum-portal tokens.json rootCustomProperties
                          --apkt-colors-semanticError100, rgba(223,74,52,1))
--focus:        #7DD3FC  (semantic focus ring; not sampled, kept distinct
                          from accent so focus is never mistaken for a link)
--font-ui:      "Geist Variable", system-ui, sans-serif   (unica substitute)
--font-mono:    "JetBrains Mono", ui-monospace, monospace
```

color-scheme: dark. No gradients anywhere (the earlier blue promo banner on
the landing route is removed: it promoted a 0.00 USDG settled figure to the
hero, which the first screen contract forbids). No glow. No emoji. Icons: a small external link mark (`^`) and generic
geometric shapes only, no protocol logos.

Mono is reserved for hashes and addresses (`.mono`, `.hex`, `.tx`, hex/numeric
inputs) and nothing else: no letter-spaced mono section labels, no numbered
section chips ("01", "02" …). The portal uses neither device.

## Type scale

Single UI face at two weights, matching the portal's own signature move
(`study.md` point 4: "heading hierarchy is carried by font-weight change,
not a size jump"):

- Page title (h1): Geist Variable weight 700, 34px desktop / 26px mobile,
  line-height 1.15.
- Section title (h2): Geist Variable weight 600, 20px, line-height 1.2.
- Body: Geist Variable weight 400, 14px/20px (arbitrum-portal tokens.json
  `elements.p`: fontSize 14px, lineHeight 20px), denser than the previous
  15px/1.55 pass, matching the portal's own tighter app-UI rhythm.
- Nav / buttons: Geist Variable weight 500, 14px (arbitrum-portal tokens.json
  `elements.button`).
- Mono: JetBrains Mono 12.5px for hashes/addresses, tabular figures
  everywhere via `font-variant-numeric: tabular-nums` plus
  `font-feature-settings: 'tnum'`.

## Spacing

8px base grid, leaning on the portal's own histogram leaders (8, 16, 12,
24px, `tokens.json spacingHistogram`) rather than the previous pass's 32px
sections. Page shell max width 1240px, 24px gutters (portal's rendered
content sits inside a ~1440px canvas with generous side gutters at that
width; 1240 keeps line length sane on an ultrawide monitor while still
reading as full-bleed after the previous 1120px narrow-column layout).
Section vertical rhythm 40px. Panels use 20px internal padding, 24-32px on
the hero-weight panels.

## Radius

- `--radius-control: 10px` (arbitrum-portal tokens.json
  `elements.button.borderRadius` / `elements.a.borderRadius`): buttons,
  inputs, small tags.
- `--radius-panel: 20px` (arbitrum-portal `desktop.png` project-card corner
  treatment, described in `study.md` as "a rounded rectangle language
  matching the project cards' corner treatment"): every large content panel.
- `--radius-pill: 999px` (arbitrum-portal `desktop.png` nav active-tab
  highlight and the `Connect Wallet` button, a true stadium shape): the nav
  track, verdict badges, the wallet chip.

## Layout: page shell

Top bar mirrors the portal's macrostructure exactly: brand mark left,
centred segmented pill nav, primary pill action right. No sidebar (the
brief calls for a wider shell, not a new rail).

Verify and Channel open with a two-column head on desktop, single column on
mobile: left is the page title and lede, right is a small "device" panel
carrying live contract state, the portal's signature move 3 ("a small
illustrative UI-within-UI device" (`study.md`), there the 3.31% APY card,
here which network/contract the page is reading). This replaces the old
design's dead right-hand whitespace: real, already-fetched numbers now
occupy the space a competitor would spend on a mock stat card.

The landing route (`/`) uses the portal's single-asset page layout instead:
title plus one tag, then a 12-column grid with the refusal panel spanning 8
columns and the call ticket spanning 4 (stacked on mobile, panel first).
Below it, full-width row-card lists for channels and keys. Contract constants
live in exactly one place, the last section on that page.

## Components

- **Nav pill**: `--bg-raise` track, `--radius-pill`, each item padding
  10px 16px. Active item gets a `--line-strong` fill and `--fg` text
  (portal's active-tab treatment is a mid-grey fill on black, not an
  inverted light chip); inactive items are `--muted`, hover raises to `--fg`.
  The external `Contract` link carries a small `^` glyph, never an icon font.
- **Match panel** (used on the Verify
  dry-run, and the Channel redeem diagnostic): a `--radius-panel` panel,
  `--bg-raise` fill, 1px `--line` border. Two mono columns (what was
  registered vs. what the receipt / quote carries) flank a verdict pill in
  the middle. The verdict pill is the single largest coloured element on the
  panel: `--radius-pill`, 13px weight 600 (not mono, not uppercase: it reads
  a word, not a hash), tinted background
  (`color-mix` at 14% into `--bg-raise`) plus a full-strength border and
  text in `--ok` or `--bad`. This is deliberately built as one object, not a
  table row, per the brief.
- **Refusal panel** (landing route only, the hero): `--bg-raise` panel,
  `--radius-panel`. Two model columns ("Channel 0 pins" / "Test receipt
  served"), each with the model string at 22px weight 600 and the hash
  below it in mono, the first four bytes at 28px so the difference is
  readable from across a room; a `≠` mark in `--bad` between them. Under both,
  a full-width verdict strip: `--bad` tinted fill, "Payment refused" at 22px
  weight 700, `ModelMismatch()` and the selector in mono, the block stamp at
  the right. The panel's frame and labels render before data; the verdict slot
  shows a skeleton until the eth_call returns.
- **Call ticket** (landing route): the portal's "Transaction details" ticket.
  `--bg-raise`, `--radius-panel`. Key/value rows for the attempted call, then a
  check list in contract order. Each check is a row with a 16px status mark
  drawn in CSS (filled `--ok` dot for passed, `--bad` ring with a bar for the
  failing check, hollow `--dim` ring for not reached) and plain text. One
  full-width primary button at the bottom.
- **Row card list**: the portal's earn list. A thin column-header row in
  `--dim` 12px, then one `--bg-raise` rounded row per item, 16px vertical
  padding, 8px gap between rows. On mobile each row becomes a two-column
  label/value grid.
- **Stat tile**: `--bg-raise` fill, `--radius-control` x2 (16px), 16px
  padding, 12px `--muted` label, 18px weight 600 value. Used in rows of four
  on the Channel page head.
- **Device stat card**: `--bg-sunken` fill inside a `--radius-panel` panel, a
  plain (non-mono) label row plus one to three stat pairs at 18px numeric
  weight. Used for the Verify "reading on" readout.
- **Connect Wallet**: a single portal-blue `.btn` pill reading "Connect
  Wallet". With exactly one available connector it connects directly; with
  more than one it opens a small menu listing each by its own wallet name
  (never "Injected").
- **Channel stat tiles**: the Channel page's head. Deposit, paid, remaining,
  payment path and status as a row of stat tiles, mirroring the portal
  opportunity page's Token/Protocol/TVL/Stakers row. No giant deposit figure:
  a 2.00 USDG testnet deposit is not a hero.
- **Buttons**: primary is the portal's own accent blue, `--radius-control`,
  weight 500, min-height 40px. Ghost keeps a 1px `--line-strong` border,
  transparent fill. Focus is always a 2px `--focus` outline, 2px offset,
  never a border-colour swap, so focus is visible on every interactive
  element regardless of the pill/pane it sits inside.
- **Inputs**: `--bg-sunken` fill, 1px `--line-strong` border,
  `--radius-control`, 40px min-height, mono for numeric/hex fields. Every
  input keeps its `<label>`; helper/error slots reserve `min-height: 1lh` so
  layout never jumps.
- **States**: unchanged in substance from the previous pass, restyled to the
  new surfaces. Every fetch renders a skeleton, an empty explanation with
  the exact next onchain action, or an error with retry. No invented data,
  ever.
- **Block stamp**: unchanged behaviour, small `--dim` text (not mono; the
  block number is a count, not a hash), "read at block #N" linking to the
  explorer.

## Motion

None by default. Nav pill and row hover are background-colour transitions
at 120ms ease-out. `prefers-reduced-motion: reduce` removes all transition
and the Stamp counter animation (already conditional in code), matching the
portal reference's own lack of observable decorative motion.
