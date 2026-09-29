# Chiron web DESIGN.md (locked, v2)

Binding for every file under `web/src`. Research behind each decision: `web/design-research/REFS.md`
(17 studied references, tokens in `web/design-research/tokens-*.json`). Identity claimed in
`/.progress/ui-v2-registry.md` (row "Chiron", 2026-09-29T04:07Z); nothing here may drift from that row.

## Art direction

Chiron is an inspection sheet: the payment and the receipt are drawn as line documents, the contract's
checks are numbered on them in the order the contract runs them, and the one check that fails is cut in
magenta. It reads like an instrument manual crossed with a test certificate, never like a dashboard.

Genre: verification report. A title block with provenance, a figure, a keyed legend, specification lines.

## Typefaces (two families)

- **Red Hat Display** (`@fontsource-variable/red-hat-display`, OFL), weights 300 to 500, display only
  (page titles, section titles, the channel and model names when they are the subject of a line). Light
  weights with negative tracking give the calm, exact tone of the TE guides' large thin product numbers
  (REFS 11, 14) without their licensed faces. It is not Inter, Roboto, Arial or a system face, and no other
  product in this workspace uses it.
- **B612** (`@fontsource/b612`, OFL), 400 and 700, for body, labels, figures, forms and tables. It was drawn
  for Airbus cockpit displays: glyphs built to be told apart at a glance under stress (0 and O, 1 and l),
  which is the job of a page whose whole point is that one string differs from another.
  **B612 Mono** (`@fontsource/b612-mono`) is allowed only where the content is literally a hash, address,
  selector or code, at 12px, truncated in the middle, with a copy control or the full value in `title`.
  Never for display, body, labels, amounts or block numbers.

## Type scale (px; tracking is explicit)

| Token | Face | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `--t-display` | Red Hat Display | 44 / 50 (mobile 26 / 31) | 300 | -0.03em | the Overview's one sentence only |
| `--t-title` | Red Hat Display | 36 / 40 (mobile 28 / 32) | 350 | -0.025em | Channel and Verify titles |
| `--t-section` | Red Hat Display | 22 / 28 | 450 | -0.012em | section titles |
| `--t-diff` | Red Hat Display | 30 / 34 (mobile 22 / 26) | 350 | -0.022em | only the pinned model, the served model and the refused amount on the Overview figure |
| `--t-subject` | Red Hat Display | 18 / 24 | 500 | -0.008em | a channel or key as the subject of a line |
| `--t-body` | B612 | 15 / 24 | 400 | 0 | prose, row text |
| `--t-small` | B612 | 13 / 20 | 400 | 0.005em | hints, provenance |
| `--t-label` | B612 | 11 / 14 | 700 | +0.08em, uppercase | title block labels, form labels, drawing labels |
| `--t-hex` | B612 Mono | 12 / 16 | 400 | 0 | literal hex only: hashes, addresses, selectors |
| `--t-code` | B612 | 0.94em | 700 | 0 | code identifiers in running text (`redeemWithReceipt`, `ModelMismatch()`) |

B612 and B612 Mono draw `( )` as near-square brackets, which turns `ModelMismatch()` into `ModelMismatch[]`.
A `Chiron Parens` face (Red Hat Display restricted by `unicode-range: U+0028-0029`) sits in front of both
stacks, so every parenthesis on the site is round.

Tabular figures (`font-variant-numeric: tabular-nums`) only inside tables and the legend's figure column.
Headings are never italic. No weight above 700 anywhere; display never above 500.

## Colour, 70 / 20 / 10

| Token | Value | Share | Job |
|---|---|---|---|
| `--ground` | #F6F8FA drafting white | 70 | the page; cool, not paper |
| `--ink` | #111318 | 20 with graphite | text, strokes of the drawing, primary button fill |
| `--graphite` | #5A6270 | (in the 20) | secondary text, dimension and leader lines, "not reached" |
| `--rule` | #D5DBE2 | (in the 20) | hairlines, the dot grid |
| `--wash` | #ECEFF3 | (in the 20) | input fill, the pressed state |
| `--signal` | #D01A6E signal magenta | 10 max, one job | the refusal only: the cut in the model line, the struck `1.00 USDG`, check 7, a revert name when the app shows a refusal |

Nothing else is coloured. Passed checks are ink ticks, not green. An app failure (the chain read failed,
or the refusal stopped happening) is an inverted ink row with ground-colour text, so it is loud without
borrowing the accent. Links are ink with a graphite 1px underline, 3px offset.

## Space, radius, elevation

- 8px scale: 4, 8, 12, 16, 24, 32, 48, 64, 96. Section gap 64 desktop, 48 mobile. Page gutter 48 desktop,
  20 mobile. Content width 1200 max; prose max 68ch.
- Radius 0 on everything that is structure. 2px on inputs and buttons only.
- Elevation: none. No shadows, no raised panels. Separation is a 1px `--rule` line or whitespace.

## Background atmosphere

The page is a drawing board: a 1px dot grid (`--rule` at 70% opacity, 16px pitch) under the figure and the
title block only, fading out below them, plus the drawing-sheet title block ruled in 1px ink across the top
of every route. Taken from Cloudflare's request-path ground (REFS 13) and the TE manuals' drawings
(REFS 11, 14, 15). No gradients, no glow, no noise texture.

## Structure, stolen, not invented

- **Title block** (every route): a single ruled strip of cells, `--t-label` label over `--t-small` value:
  contract, chain, read at block, and the route's own verdict or subject. From Cloudflare Docs'
  provenance row (REFS 16, `refs/cf-docs-pricing-1440.png`) and an engineering drawing's title block.
- **Figure with numbered callouts** (Overview): the channel, the voucher and the receipt drawn as line
  documents with their live values written inside them at body size (TE TP-7, REFS 15,
  `refs/te-guide-tp-7-1440.png`), and circled numbers 1 to 9 placed on the fields each check reads (TE
  OP-1 field, REFS 11, `refs/te-guide-1440.png`).
- **Keyed legend** (Overview): one full-width 44px row per check, circled number, the check in words, what
  was read, the result. Order is the contract's evaluation order. From the EP-133 index (REFS 14,
  `refs/te-guide-ep-133-1440.png`).
- **Specification lines** (channels, keys, constants): subject in `--t-subject`, then one metadata line with
  1px vertical hairline separators (`receipt-only | pins meta-llama/llama-3.3-70b-instruct | 2.00 USDG
  deposited | 0.00 paid`). From OpenRouter's model list (REFS 5, `refs/openrouter-models-table-1440.png`).
- **Codes small, meanings large** (every revert and error): selector in `--t-hex`, the sentence in
  `--t-body`. From Cloudflare's error table (REFS 17).
- **Forms** (Channel, Verify): ruled rows, label left in `--t-label`, input right with a 1px bottom rule
  and `--wash` fill; actions at the end of the step. Steps are numbered because they are a real order.

## Motion

One orchestrated sequence, on the Overview's first-screen visual, once the chain read resolves:
1. 0 to 400ms: the two documents (what channel 0 was opened for, what the test receipt says) wipe in.
2. 1300 to 1750ms: the leader between the two model names draws from both ends.
3. 1600ms: the magenta cut lands in the gap and `served-model` turns magenta.
4. 1700 to 2020ms: the strike runs through `1.00 USDG`.

Opening "Inspect the call" runs the second half of the same sequence on the full sheet: callouts 1 to 6 fill in
contract order 150ms apart and tick their legend rows; 7 is magenta; 8 and 9 stay dashed, not reached.

State transitions: route content fades 160ms; a submitted form shows its result line in place. Easing
`cubic-bezier(0.2, 0, 0, 1)`. No count-ups, no hover lifts, no scattered micro-animations.
`prefers-reduced-motion: reduce` renders the final state with no animation.

## Refusal list

- No cards, tiles, raised panels or rounded boxes; nothing nested inside a bordered box.
- No pills, badges or status chips. State is a word in the row.
- No big-number hero; no figure larger than `--t-subject`, except the three `--t-diff` strings that are the argument itself.
- No mono outside literal hex. No full 64-character hash in running layout; hashes and addresses sit behind a click.
- No green, red, blue, purple, teal, amber or orange. One accent, one job.
- No gradients, glows, shadows, glass, neon.
- No icons above headings; no decorative icons at all. Circled numbers are the only glyphs.
- No count-up numbers, sparklines, charts.
- No em dashes; no emoji; no names of other products or projects in the UI.
- No copy that implies a real llama call was swapped. The receipt is a test receipt signed by a test key,
  whose served model is the string `served-model`, offered to live channel 0.

## Composition of the first screen (phase 3 pick, `design-research/PICK.md`, then the Simplicity rule)

Every route: one sentence that names its job, one visual, one primary action. Terms get a one-line gloss the
first time they appear. Hashes, addresses and the contract-order checks sit behind a click.

```
Overview
[ title block: network | read live at block N | VERDICT: Payment refused (magenta fill) ]
[ one sentence, display 44                  ]   [ gloss: sealed gateway, receipt ]
[                                           ]   [ Open a channel pinned to a model ]
[ caption: this receipt names a different model than the one channel 0 was opened for ... ]
[ CHANNEL 0 WAS OPENED FOR      ]  --//--  [ TEST RECEIPT SAYS IT SERVED ]
[ meta-llama/llama-3.3-70b-...  ]  magenta [ served-model                ]
[ 1.00 USDG struck: not paid. It stays in channel 0. A read-only call. ]
[ + Inspect the call: the full sheet, voucher, call, callouts 1-9, legend, receipt bytes ]
then channels and keys as specification lines, what the proof covers, contract constants

Channels: title block | "Lock USDG for one model, then pay per call" + gloss + Open a new channel |
  channel picker | one drawn document: what the channel pays for, what is left, its state |
  clock, addresses and fingerprints behind a click | receipt payments | every channel as specification
  lines | open form | steps 1 to 3
Verify: title block | "Verify a gateway, then register its key" + gloss + Read the nonce for the live
  provider | the two registered keys as drawn documents (can sign until, fingerprint) with the hex behind a
  click | steps 1 to 3 | how registration works
```

Mobile stacks everything in one column; the first screen keeps the sentence, the visual and the action.
