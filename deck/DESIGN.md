# Signet deck DESIGN.md

Binding for `deck/index.html`. The deck extends `web/DESIGN.md` (the gate log) so the pitch and the product read as one system.

## Art direction

The deck is the gate log at presentation scale. One idea per slide. The headline is the takeaway. Evidence sits in a log panel on the right: an amber dot is a verified state, a red ring is a refusal, nothing else is coloured.

## Tokens

Same values as `web/DESIGN.md`: `--color-bg #121315`, `--color-panel #17191c`, `--color-raise #1d2024`, `--color-line #26292e`, ink `#e9e7e2`, soft `#b5b3ad`, mute `#8d9097`, amber `#f2b134` (verified), red `#ef5a4c` (refusals only). Spacing 4/8 scale, radius 6.

## Type

Archivo at 600 and 96% width with -0.035em tracking for headlines, 400 for body. IBM Plex Mono for hashes, addresses, block numbers, labels. Headlines are roman. No eyebrows, no numbered ghost labels.

## Motion

One reveal per slide (panel and headline rise 10px), none looping, removed under `prefers-reduced-motion`. Keyboard: arrows, space, page keys, home, end.

## Layout

Two columns above 960px (argument left, evidence panel right), one column below with the rail narrowed to 32px. Slide 4 is a single-column five-step flow. No fake browser chrome, no stat grid, no equal three-card rows.
