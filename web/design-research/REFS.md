# Chiron design references

Captured 2026-09-29 with `scripts/refshot.py` in the bhn `deepsurge` profile (waits for load, fonts and
network quiet; rejects blank, error and challenge pages). Every entry below was written after viewing both
PNGs and reading the `.tokens.json` beside them. Token values are quoted from those files unless marked
"measured", which means read off the screenshot at 1x.

The problem shape Chiron has: a developer needs to see one payment walk through a fixed list of checks in
contract order, see the exact place it stops, and trust that each value on screen came from a named read.
References were chosen for how they show a lifecycle, a named error, a typed object and a money figure, not
for how their marketing hero looks.

## 1. Stripe Docs, PaymentIntent lifecycle page (north star, screen 1 of 3)

- Files: `refs/stripe-lifecycle-1440.png`, `refs/stripe-lifecycle-390.png`, `refs/stripe-lifecycle-1440.tokens.json`.
- What it is: a reference page that explains how one payment object moves through a fixed set of states.
  Left nav, one prose column, an "On this page" rail, then a three-column state table.
- Move worth stealing: the prose column carries the argument and the data sits inside it. h1 32px weight 700,
  leading 40px, colour rgb(26,31,54); lede h2 24px weight 400, leading 32px; paragraph 16px, leading 26px,
  colour rgb(60,66,87); link colour rgb(84,105,212). The contrast between the 700 title and the 400 lede at
  0.75x its size is the whole hierarchy; there are no boxes around the prose. The state table uses small caps
  column heads (measured about 13px, tracked out, grey) over plain rows, and API names are inline code chips
  in running text rather than separate panels.
- Numbers, empty state, primary action: no figures on this page; states are named in prose
  (`requires_payment_method`). The primary action is reading; the only buttons are quiet utilities (Copy for
  LLM, View as Markdown) set at 13px under the title and divided by hairlines.
- Mobile: the h1 wraps to three lines at 32px, the lede stays 24px, the side rails collapse into one icon
  button beside the breadcrumb. Nothing is hidden; order is preserved.
- Not to take: the system font stack (`-apple-system, system-ui, Segoe UI, Roboto`), which is exactly the
  default-sans tell; the blue-violet link colour, which is Stripe's identity; the three-rail docs chrome, which
  would make Chiron read as a docs site rather than a working product.

## 2. Stripe API reference, the PaymentIntent object (north star, screen 2 of 3)

- Files: `refs/stripe-api-object-1440.png`, `refs/stripe-api-object-390.png`, `refs/stripe-api-object-1440.tokens.json`.
  Rendered in the profile's dark scheme.
- What it is: the typed definition of one object. Left: an attribute list. Right: a sticky panel with the
  object as it would come back from the API.
- Move worth stealing: the attribute row. Field name in bold mono (`amount`), then the type and access note in
  small grey on the same baseline (`integer  retrievable with publishable key`), then one plain-language
  paragraph, then a hairline. Title h1 24px weight 700, leading 32px; section h3 16px weight 600; body 14px,
  leading 22px; nav link colour rgb(140,153,173); radius 8px on the search button and 4px on nav items.
  This is how Chiron's `channels(0)` struct should read: each field named by its contract getter, typed,
  explained once, and read from the chain. The right-hand object panel is the one place code is shown at
  length, and it is shown as the real payload, not decoration.
- Numbers, empty state, primary action: money is explained as base units in prose ("100 cents to charge
  $1.00"), which is exactly the USDG 6-decimal problem. Nullable fields say `null` in the payload rather than
  hiding. There is no primary button; "Show child attributes" is a quiet outlined pill with a plus.
- Mobile: the object panel drops away, the attribute list becomes the page, the name and type wrap onto two
  lines, and the link icon moves to the row's right edge.
- Not to take: the full-height syntax-coloured JSON (green strings, blue keywords) as a wall; the system font
  stack; the dark theme as Chiron's default, since the prior rejected UI was black.

## 3. Stripe Docs, error codes table (north star, screen 3 of 3)

- Files: `refs/stripe-errors-1440.png`, `refs/stripe-errors-390.png`, `refs/stripe-errors-1440.tokens.json`.
- What it is: a filterable table mapping every error code to one plain sentence about what happened.
- Move worth stealing: an error is a name plus a sentence, nothing else. Code in an inline chip
  (`account_closed`, measured 13px mono on a light fill with a 1px border), description in 14px body beside it,
  rows split by hairlines, no icons, no severity colour. Small caps label h3 12px weight 600, tracking 0.49px,
  colour rgb(79,86,107), used once as the heading of a side note. Title 32px/40 weight 700 and lede 24px/32
  weight 400 repeat exactly from screen 1, which is what makes three different pages feel like one system.
  Chiron's `ERROR_HELP` map (PayerNotAgent, ModelMismatch, StaleRefBlock and 28 more) is this table already;
  every revert the app shows should look like one of these rows.
- Numbers, empty state, primary action: the filter input sits inside the table head (radius 6px, 14px
  text), so filtering is part of the table, not a toolbar above it. No empty state is shown because the list
  is static.
- Mobile: the side note moves above the prose and becomes a bordered box; the two-column table keeps both
  columns at 390 by letting the description column take the rest.
- Not to take: the blue left-border callout ("Card decline errors"), which is the thick-coloured-border tell
  in miniature; the grey table-head fill.

## 4. OpenRouter, providers for meta-llama/llama-3.3-70b-instruct (secondary A, screen 1 of 3)

- Files: `refs/openrouter-providers-1440.png` (full page, 1440x8960, viewed as the top 1800 px crop),
  `refs/openrouter-providers-390.png`, `refs/openrouter-providers-1440.tokens.json`.
- What it is: the exact model Chiron's channel 0 pins, and the eleven companies that serve it. The page's own
  copy states Chiron's problem: "Different companies host the same model. OpenRouter routes your request to
  one of them." Whoever serves the call is chosen after the buyer asks.
- Move worth stealing: the model id set as a plain slug under the title (h3 14px weight 500, colour
  rgba(252,252,254,0.627)) with the owner half underlined, so `meta-llama/llama-3.3-70b-instruct` reads as a
  path, not a hash. Right-aligned numeric columns in a 14px table with a unit suffix in smaller grey
  (`$0.10 /M`, `0.46s`, `14 tps`), and an absent value written as `--`, never 0. Fonts loaded: gordita for the
  h1 (20px weight 600, leading 24px), Plus Jakarta Sans for everything else (body 14px weight 450, leading
  22.75px), geistMono only where code is shown. Buttons radius 6px, fill rgba(252,252,254,0.04).
- Numbers, empty state, primary action: every price is a number with its unit in a lighter tint; a discount
  is a struck-through old price beside the new one. Missing uptime is a grey bar plus `--`. The primary action
  "Try this model" is the only lime element on the screen; it repeats in a sticky sub-header as you scroll.
- Mobile: the table keeps its first column and scrolls sideways; the three actions become a fixed bottom bar
  (Compare, API, Try) at 48px.
- Not to take: the near-black rgb(3,8,10) body with a lime rgb(200,255,0) accent (the "dark plus acid accent"
  default); provider logos as colour noise; the price-history multi-line chart, which is decoration on a page
  about routing.

## 5. OpenRouter, model list (secondary A, screen 2 of 3)

- Files: `refs/openrouter-models-table-1440.png`, `refs/openrouter-models-table-390.png`,
  `refs/openrouter-models-table-1440.tokens.json`. (The `?fmt=table` URL still rendered the list view; the
  list is what was studied.) A first attempt at `/activity` hit a sign-in wall and was deleted.
- What it is: every model as one row: name, a two-line description, then a metadata line.
- Move worth stealing: the metadata line. `by anthropic | Sep 28, 2026 | 1M context | $1/M input tokens`
  at 14px weight 450 in a muted tint, items separated by 1px vertical hairlines, not pills. The usage figure
  (`10.3M tokens`) sits right-aligned on the title baseline in the same muted tint, with an info icon. Title
  h1 20px weight 600, leading 24px. This is the pattern for Chiron's channel rows: `channel 0 | receipt-only |
  pins meta-llama/llama-3.3-70b-instruct | 2.00 USDG deposited | 0.00 paid`, one line, hairline-separated.
- Numbers, empty state, primary action: numbers carry their unit in words (`1M context`, `$5/M output
  tokens`). Filters live in a left rail of collapsible groups; the page's actions (Compare, Discover) are
  outlined 6px-radius buttons in the header. No empty state visible.
- Mobile: rows drop the logo and the description clamps to two lines; the metadata line clips at the right
  edge instead of wrapping, which loses the price. Chiron's metadata line must wrap.
- Not to take: rows as bordered rounded cards with 8px gaps (card lists), the small status badges
  (`50% off` in a green pill), the colour logos.

## 6. OpenRouter, uptime for the same model (secondary A, screen 3 of 3)

- Files: `refs/openrouter-uptime-1440.png`, `refs/openrouter-uptime-390.png`, `refs/openrouter-uptime-1440.tokens.json`.
- What it is: a health read for one model: two figures, a 3-day availability strip and a 24-hour line chart.
- Move worth stealing: the section opener. An icon plus a 16px weight 500 heading ("Uptime"), then a
  three-line definition paragraph at 16px/27.2 that states exactly what the number measures ("the percentage
  of the past 3 days that at least one provider was responding") before the number appears. The strip of 72
  bars with only four axis labels (Sat, Sun, Mon, Now) shows time without a chart library. Chiron can use the
  same definition-first opener: say what `requestedModelHash` is before showing it.
- Numbers, empty state, primary action: the figures are small (measured about 16px) in green with a small
  caps label above (`UPTIME (3D)`), which is honest sizing for a health metric. Absent data is omitted from
  the legend rather than drawn as zero.
- Mobile: the two figure boxes stack; the strip keeps all bars by thinning them.
- Not to take: the figure boxes nested inside a bordered panel (cards in cards); the green-on-black metric,
  which drifts toward the big-metric tile; the jagged orange line chart as atmosphere.

## 7. Mercury (demo.mercury.com), home (secondary B, screen 1 of 3)

- Files: `refs/mercury-dashboard-1440.png`, `refs/mercury-dashboard-390.png`, `refs/mercury-dashboard-1440.tokens.json`.
  The public demo account; rendered in the profile's dark scheme, background rgb(23,23,33).
- What it is: a bank's home: greeting, a row of money actions, balance with a 30-day chart, accounts list.
- Move worth stealing: the money figure. `$5,216,471.18` with the cents set smaller and raised
  (measured: dollars about 28px, cents about 16px on the cap line), so the eye reads the dollars and the cents
  stay exact. The display face is light: h1 Arcadia Display 28px weight 380, leading 36px; body Arcadia Text
  16px weight 360. Light weights on money read calm and expensive instead of loud. The verbs (Send, Transfer,
  Deposit, Request, Upload bill) are a single row of 15px pill buttons with one filled (Send, rgb(82,102,235)).
- Numbers, empty state, primary action: in-flows and out-flows carry an arrow glyph and a sign
  (`↗ $1.8M`, `↘ -$479K`) instead of green/red tiles. Bill Pay shows `Due soon -` : an absent count is a
  dash. One filled primary per screen.
- Mobile: the action row collapses to one full-width "Send money" plus "More"; the accounts list keeps the
  raised-cents treatment right-aligned.
- Not to take: the purple-blue accent; the area chart under the balance (the sparkline-as-impact tell);
  the onboarding popover.

## 8. Mercury, transactions (secondary B, screen 2 of 3)

- Files: `refs/mercury-transactions-1440.png`, `refs/mercury-transactions-390.png`, `refs/mercury-transactions-1440.tokens.json`.
- What it is: the ledger. Date, counterparty, amount, account, method, category.
- Move worth stealing: a payment that did not happen. Row 2, "Payment from NASA", shows its amount
  `$419.00` struck through, plus a small outlined "Failed" label beside the name. The money is still on the
  row, exact, and visibly not moved. That is the single most useful move for Chiron: the refused voucher is
  `1.00 USDG`, struck through, on the line where it would have been paid. Amount column right-aligned with
  raised cents; incoming amounts in green, outgoing in the default text colour with a minus sign (no red for
  normal spending). Paragraph 13px, tracking 0.1px, leading 20px for help text.
- Numbers, empty state, primary action: three summary figures (Net change, Money in, Money out) sit as a
  plain line above the table at about 20px, not in tiles. Empty category cells show an empty select, not
  "none".
- Mobile: the table keeps date and counterparty and lets amount scroll off; the summary figures stay.
- Not to take: the colour avatars, checkbox column and category selects; the tooltip popover.

## 9. Mercury, payments inbox (secondary B, screen 3 of 3)

- Files: `refs/mercury-payments-1440.png`, `refs/mercury-payments-390.png`, `refs/mercury-payments-1440.tokens.json`.
- What it is: bills awaiting action, in tabs by state (Inbox, Needs Approval 7, Scheduled 7, Paid).
- Move worth stealing: the table on an empty field. Three rows, then the page simply ends; there is no
  filler, no illustration, no "load more". Row height measured 66px, 15px text, a 1px divider, amounts right
  aligned. State counts ride as small grey count chips after the tab label. h1 28px weight 380 with a
  secondary action ("Send money", icon plus text, no fill) on the same line.
- Numbers, empty state, primary action: "Overdue" is a small rust-filled label, the only colour in the
  table. The Paid tab has no count, which says "nothing here needs you".
- Mobile: tabs scroll horizontally; the table clips columns rather than stacking.
- Not to take: coloured status labels on every row (status pills everywhere); the sidebar tree.

## 10. Phala TEE Attestation Explorer (proof.t16z.com)

- Files: `refs/phala-proof-1440.png` (full page), `refs/phala-proof-390.png`, `refs/phala-proof-1440.tokens.json`.
- What it is: the attestation vendor's own verification tool: paste a hex quote, press Verify, see a list of
  recent report hashes with a pass or fail shield.
- Move worth stealing: one idea only. The input is honest about what it takes: the placeholder is the real
  first bytes of a quote (`0x030002000000...`) set in mono, so the user knows the format before pasting.
  Chiron's Verify textarea should show the real shape of the attestation JSON the same way.
- Numbers, empty state, primary action: h1 Lato 36px weight 900, tracking -0.9px, leading 40px; small caps
  section labels 16px weight 500, tracking 0.4px, colour oklch(0.5103 0 263.28); Verify button 14px weight 700
  on oklch(0.8962 0.1971 123.29) with radius 10px. Status is a 20px shield icon (green pass, red slash fail).
- Mobile: the two white panels stack; the hash column clips at the right edge.
- Not to take (this is mostly a negative reference, and it is the domain's own default): twenty full
  64-character hashes in mono with "just now" beside them, which tells a person nothing; two big white rounded
  panels on grey (cards); weight 900 heading; the lime button. This is exactly the "wall of monospace hashes"
  the user rejected. Chiron must never list a hash that the reader cannot act on, and must translate every
  hash it does show into what it names (a model id, a measurement on the allowlist, a key's expiry).

## 11. Teenage Engineering, OP-1 field user guide

- Files: `refs/te-guide-1440.png` (full page, 1440x42518; viewed as crops of the top 2000 px and of
  y 5200 to 6700), `refs/te-guide-390.png`, `refs/te-guide-1440.tokens.json`.
- What it is: a product manual as a web page. A line drawing of the whole instrument, then numbered topics,
  each a pair of panels: prose on the left, a cropped line drawing with labelled leader lines on the right.
- Move worth stealing: the labelled line drawing. The device is drawn in 1.5px black strokes on the page
  colour, and every part the text mentions has a leader line and a lowercase label (`internal speaker`,
  `volume knob`, `usb c`, `audio in`). Nothing is shaded or glowing. For Chiron this is the refusal: a drawn
  voucher and a drawn receipt, each field labelled with a leader line to the contract check that reads it,
  and the one line where the served model breaks. Type is all one family in very light weights: body
  te-20 16px weight 300, leading 24px; nav 19px weight 100; section titles measured about 56px at weight 300,
  set lowercase. Page colour rgb(240,239,234), text rgb(15,14,18), secondary rgb(77,77,77). Full-width 1px
  rules divide chapters.
- Numbers, empty state, primary action: specifications are plain text lines (`ambient working temperature:
  10-35°C (50-95°F)`) in the body size, never enlarged. The only action is `download as PDF`, bottom right, in
  grey text. Version `V.1.7.0` sits top right at 12px.
- Mobile: the drawing scales down intact; the four warning columns become two; nothing is cut.
- Not to take: the licensed te-20 and te-40 faces; the everything-lowercase voice, which is TE's identity;
  the rounded panel pairs with 1px borders (they are cards, if quiet ones); the warm near-cream page colour,
  which sits next to the cream-and-serif default.

## 12. Linear, Now (changelog)

- Files: `refs/linear-changelog-1440.png`, `refs/linear-changelog-390.png`, `refs/linear-changelog-1440.tokens.json`.
- What it is: dated release notes; each entry is a heading, a small diagram of the feature, then prose.
- Move worth stealing: the negative tracking scale and the diagram-as-explanation. h1 48px weight 510,
  tracking -1.056px (-0.022em), leading 48px; h2 32px weight 590, tracking -0.704px (-0.022em), leading 36px;
  h3 24px weight 590, tracking -0.288px (-0.012em); body 17px, leading 27.2px, colour rgb(208,214,224).
  Tracking tightens as size grows and relaxes to normal at body size: the exact rule the brief asks for.
  The feature diagram is two lanes of small labelled nodes joined by thin curved arrows, drawn in 1px grey
  strokes with 11px uppercase mono labels, placed in the prose column at the width of the text. It explains
  a flow (issue to agent to pull request) in the time it takes to glance at it.
- Numbers, empty state, primary action: the date is the only figure, 15px on a vertical timeline with an
  orange dot marking the latest entry: one accent, one job ("newest"). Nav links 13px rgb(138,143,152),
  pill radius 9999px only on Sign up.
- Mobile: the timeline rail disappears and the date sits above the title; the diagram scales down whole.
- Not to take: Inter Variable (banned for Chiron); the near-black rgb(8,9,10) canvas; uppercase mono labels
  on dark (the hacker vibe when overused).

## 13. Cloudflare Workers product page

- Files: `refs/cloudflare-workers-1440.png`, `refs/cloudflare-workers-390.png`, `refs/cloudflare-workers-1440.tokens.json`.
  (The first capture of this page, taken before render, was blank white and was deleted.)
- What it is: the product page for the serverless runtime. A request-path diagram opens the page, then the
  headline, then three plain benefit columns.
- Move worth stealing: the background is the domain. A 1px dot grid, dashed request paths that curve into a
  selected node (`Workers`, 1px blue frame with square corner handles like a design tool selection), and
  small corner ticks where section frames meet. The atmosphere is a request routing diagram, not a gradient.
  Chiron's equivalent is the payment's path through the checks. Type: h1 FT Kunst Grotesk 56px weight 500,
  tracking -1.4px (-0.025em), leading 55.44px (0.99); sub 19.2px weight 400, tracking -0.48px; body 16px,
  leading 24px, colour rgb(240,227,222) on rgb(21,20,20); node labels in Apercu Mono Pro 16px,
  colour rgb(77,184,255).
- Numbers, empty state, primary action: the columns state price terms in words ("Pay only for execution
  time (CPU time), not idle time spent waiting on I/O"). One filled orange primary, one outlined secondary,
  both 50px tall, radius about 25px.
- Mobile: the diagram crops to the one selected node; buttons go full width and stack.
- Not to take: the orange-on-near-black brand pairing; the centred marketing hero; icon-over-heading
  feature columns.

## 14. Teenage Engineering, EP-133 K.O. II user guide

- Files: `refs/te-guide-ep-133-1440.png` (full page, 1440x10315; viewed as crops of the top 1600 px and of
  y 4200 to 5800), `refs/te-guide-ep-133-390.png`, `refs/te-guide-ep-133-1440.tokens.json`.
- What it is: the manual for a sampler. A flat colour drawing of the device with every control labelled,
  a what's-in-the-box row, then an index of numbered chapters.
- Move worth stealing: two things. First, the page colour is cool, not warm: rgb(241,242,242) (sampled
  pixel and `htmlBg`), with ink rgb(15,14,18); this is the neutral technical ground Chiron needs, clear of
  every paper tone. Second, the index: chapters as full-width 58px rows, top-level rows inverted (ink fill,
  page-colour text, a circled chapter number), sub-rows in a mid grey fill with a decimal number
  (`4.1 GROUPS`, `4.2 PADS`), 1px separators. The numbers are true: they are the manual's order. Chiron's
  checks are also a true order (the order `redeemWithReceipt` evaluates them), so they may be numbered the
  same way. Labels are uppercase at about 11px beside controls in the drawing (`VOLUME`, `BPM`, `METRONOME`),
  with bracket lines grouping related controls (`GAIN`, `SWING`).
- Numbers, empty state, primary action: the version (`VER 2.5`) and the product number (`EP-133`) are the
  only figures in the header; the product number is set huge (measured about 56px) in the thin face, the one
  large element on the page. No primary button.
- Mobile: header columns shrink to four narrow columns at small size; the drawing scales intact.
- Not to take: the orange (Chiron cannot use orange: vermilion and amber are other products' accents); the
  all-caps body paragraphs; the starburst "NEW OS!" badge.

## 15. Teenage Engineering, TP-7 field recorder user guide

- Files: `refs/te-guide-tp-7-1440.png` (full page, 1440x38056; viewed as the top 1600 px crop),
  `refs/te-guide-tp-7-390.png`, `refs/te-guide-tp-7-1440.tokens.json`.
- What it is: the manual for a tape-style recorder; a single line drawing of the device, a four-column
  notice block, then the index.
- Move worth stealing: restraint in the drawing. One weight of stroke (measured 1px to 1.5px), no fill
  except the three transport glyphs (record dot, play triangle, stop square) and one inverted label chip
  (`TP-7`). The drawing contains its own live values (`96 / 24`, `3`) as small text inside the device, so the
  figure is the readout. For Chiron: the pinned model and the served model should be written inside the
  drawn documents, at text size, rather than pulled out into metric tiles.
- Numbers, empty state, primary action: `V.1.1.9` 12px top right; body te-20 16px weight 300, leading 24px,
  colour rgb(0,0,0) with secondary links rgb(77,77,77); four columns of 13px notices under a 56px lowercase
  title "notice. read this first.".
- Mobile: drawing centred and scaled, columns become two.
- Not to take: the warm ground rgb(240,239,234) on this guide (Chiron takes the cool EP-133 ground instead);
  lowercase-only headings.

## 16. Cloudflare Docs, Workers pricing (secondary B, screen 2 of 3; screen 1 is entry 13)

- Files: `refs/cf-docs-pricing-1440.png` (full page, 1440x18753; viewed as the top 1500 px crop),
  `refs/cf-docs-pricing-390.png`, `refs/cf-docs-pricing-1440.tokens.json`.
- What it is: how Workers is billed: prose, a plan table (Free, Standard) with footnoted limits.
- Move worth stealing: prices and limits as sentences inside table cells ("10 million included per month
  +$0.30 per additional million"), with superscript footnote numbers on the column head (`Requests 1,2,3,4`)
  that resolve in numbered notes under the table. For Chiron this is how a USDG amount, the 6-decimal base
  unit and the channel timeout should read: a figure with its unit and its caveat, not a tile. The page
  header puts provenance on one hairline-divided utility row under the title: `Last updated Aug 28, 2026 |
  Copy as Markdown | View as Markdown`. Chiron's equivalent: `read at block 313,814,703 | Assay 0x3500...`.
  h1 35px weight 600, tracking -0.875px (-0.025em), leading 43.75px; h2 20.8px weight 600, tracking -0.312px;
  body 16px, leading 28px.
- Numbers, empty state, primary action: all figures are in running text; no big numbers anywhere.
- Mobile: rails collapse into an "Overview" select under the title; the table scrolls.
- Not to take: Inter Variable and JetBrains Mono (both banned for Chiron); the blue info callout box; the
  dark oklch(0.192 0 0) ground; the orange link colour.

## 17. Cloudflare Docs, Workers errors and exceptions (secondary B, screen 3 of 3)

- Files: `refs/cf-docs-errors-1440.png` (full page, viewed as the top 1500 px crop), `refs/cf-docs-errors-390.png`,
  `refs/cf-docs-errors-1440.tokens.json`.
- What it is: every runtime error code with its meaning, then one section per notable error explaining the
  cause in prose.
- Move worth stealing: the code is small and the meaning is large. The code sits in a 13px mono chip at the
  start of the row (`1101`, `1102`), the meaning is a full 16px sentence ("Worker threw a JavaScript
  exception."). Then each important code gets its own h3 section ("Loop limit") that explains the mechanism
  with the relevant header name inline. This is the rule for Chiron's reverts: `ModelMismatch()` and its
  selector `0xa407e5f7` are small and exact; the sentence that says what happened is the thing you read.
- Numbers, empty state, primary action: none beyond codes. Mobile keeps both columns at 390 with the code
  column shrunk to the chip width.
- Not to take: zebra striping on a dark ground; the chip style used for every code in body text, which
  turns prose into a wall of chips.

## Negative references: the current Chiron UI

- Files: `negative/overview-1440.png` (full page, 1440x2487), `negative/overview-390.png`,
  `negative/channel-1440.png` (1440x3416), `negative/channel-390.png`, `negative/verify-1440.png`,
  `negative/verify-390.png`, each with its `.tokens.json`. Captured with refshot from the `ui-v2` worktree
  before any change (Geist Variable and JetBrains Mono loaded).
- Tells present, from the brief's list:
  - Geist plus JetBrains Mono: a default Vercel pairing, and mono used for model names, amounts, addresses,
    the ticket title and the check details. Present: the monospace hacker vibe.
  - The big-metric template: `0x245e10b5` and `0x8f033fe3` set at about 32px mono as the two largest things
    on the page, with the tails of the hashes in 11px mono under them. Present.
  - Cards inside cards: the refusal panel (rounded, raised) contains the red verdict box (rounded, bordered)
    and a code panel (rounded, filled); the Channel page puts five stat tiles inside the state section beside
    a raised "Open a channel" panel that holds two more bordered option cards. Present.
  - Status pills everywhere: `test receipt`, `receipt-only`, `legacy signature`, the segmented nav, the
    channel picker, `allowlisted` in green. Present.
  - Thick coloured border on a rounded card: the verdict box has a 1px red border on a dark red fill with a
    12px radius; the selected payment-path option has a blue border. Present.
  - Neon on dark: a saturated blue #325ee6 button and bright green dots on black. Present.
  - Big rounded icon above headings: absent. Purple gradient: absent. Glassmorphism: absent.
  - Sparklines and elastic motion: absent; the only motion was a count-up on the block number, which is
    fake impact of the same family. Present in the code (`useTick`).
  - Huge display type with no negative tracking: the h1 is 36px weight 700 with tracking `normal`. Present.
  - Same-family colour goo: blue button, blue selection, blue focus ring, blue link underline. Present.
  - Unnecessary detail: full 64-character hashes, the measurement hash repeated in every row, the raw
    `upstream.verified` JSON block. Present.
- What the negative gets right and the rebuild keeps: the order of the checks, the honesty paragraph, the
  fail-loudly branch when the call stops reverting, and "read at block N" beside each read.

## Decision: north star and secondaries

The registry (`/.progress/ui-v2-registry.md`) rules out Stripe (Payday), Mercury (Heracles), serif and
editorial genres, paper or warm-light grounds, and green, teal, amber and vermilion accents. Chiron's genre is
the verification report: an inspection document with a verdict, provenance and the checks in contract order.

- North star: Teenage Engineering product guides (entries 11, 14, 15; three product screens). Stolen: the
  labelled line drawing of the object under inspection, the cool technical ground rgb(241,242,242), numbered
  rows that encode a true order, specifications as body-size text lines, one inverted chip as the only filled
  element in a drawing.
- Secondary A: OpenRouter model pages (entries 4, 5, 6; three product screens). Stolen: the model id as a
  path slug, the hairline-separated metadata line, definition-first section openers, absent values as `--`.
- Secondary B: Cloudflare Workers (entries 13, 16, 17; three product screens). Stolen: the request path as
  the page's background structure (dot grid, dashed path, the selected node with corner handles), provenance
  as a hairline utility row under the title, codes small and meanings large.
- Also used for one principle each: Linear (tracking that tightens with size), Phala explorer (the input
  shows the real format; everything else is the thing to avoid).
