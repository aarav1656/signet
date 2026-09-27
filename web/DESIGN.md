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
--dim:          #6C6C6C  (arbitrum-portal tokens.json rootCustomProperties
                          --apkt-colors-neutrals600)
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

color-scheme: dark. No gradients on functional surfaces, with one named
exception: the Providers page hero banner, which follows the portal's own
blue "Start Earning Today" promo-banner pattern (`study.md` signature move
3) because it is the one place this app states its live headline figures,
the same job that banner does on the portal. No gradient anywhere else. No
glow. No emoji. Icons: a small external link mark (`^`) and generic
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

Providers, the landing route, opens with the hero banner instead (see
Components below): the device pattern still appears, but inside the banner
rather than beside a lede paragraph, carrying the headline live figures
instead of contract constants. Contract constants live in exactly one place
on that page, the "Contract constants" section near the bottom; nothing
duplicates it.

## Components

- **Nav pill**: `--bg-raise` track, `--radius-pill`, each item padding
  10px 16px. Active item gets a `--line-strong` fill and `--fg` text
  (portal's active-tab treatment is a mid-grey fill on black, not an
  inverted light chip); inactive items are `--muted`, hover raises to `--fg`.
  The external `Contract` link carries a small `^` glyph, never an icon font.
- **Match panel** (the product's centrepiece, used on Providers, the Verify
  dry-run, and the Channel redeem diagnostic): a `--radius-panel` panel,
  `--bg-raise` fill, 1px `--line` border. Two mono columns (what was
  registered vs. what the receipt / quote carries) flank a verdict pill in
  the middle. The verdict pill is the single largest coloured element on the
  panel: `--radius-pill`, 13px weight 600 (not mono, not uppercase: it reads
  a word, not a hash), tinted background
  (`color-mix` at 14% into `--bg-raise`) plus a full-strength border and
  text in `--ok` or `--bad`. This is deliberately built as one object, not a
  table row, per the brief.
- **Hero banner** (Providers page only): the portal's blue promo-banner
  pattern (`study.md` signature move 3), headline copy left, a dark device
  stat card right holding the page's three live figures (verified signers,
  USDG settled, channels open). The one gradient surface in the app; see
  Tokens above.
- **Device stat card**: `--bg-sunken` fill (or, inside the hero banner, a
  dark overlay on the blue gradient) inside a `--radius-panel` panel, a
  plain (non-mono) label row plus one to three stat pairs at 18px numeric
  weight. Used for the hero banner figures, the Verify/Channel "reading on"
  readout, and the Channel deposit figure.
- **Connect Wallet**: a single portal-blue `.btn` pill reading "Connect
  Wallet". With exactly one available connector it connects directly; with
  more than one it opens a small menu listing each by its own wallet name
  (never "Injected").
- **Deposit hero figure**: the Channel page's central object. One giant
  tabular number (Geist 700, 44px desktop / 32px mobile) for the deposit,
  paid and remaining rendered as two smaller stat chips directly beneath it,
  mirroring the portal earn-card's big-APY-plus-TVL-plus-protocol layout.
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
