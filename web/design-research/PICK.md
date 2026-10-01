# Phase 3 pick: mockup A, the inspection sheet, with B's display-size diff

Judged by a fresh `demo-judge` agent on 2026-09-29 against REFS.md, the negative captures, the tell list
and the identity registry, from `mockups/{a,b,c}-{1440,390}.png`.

| | A inspection sheet | B model diff + strip | C receipt tape |
|---|---|---|---|
| 5-second test | 5/10 | 8/10 | 4/10 |
| Big-metric template | absent | present (huge model id, small label, stats right, accent) | absent |
| Status pills / stock stepper | none | 9-dot stepper | none |
| Unnecessary detail | some | lowest | some |
| Other tells | absent | absent | absent |

## Why A

1. It is the only one that matches Chiron's registry row (title block, figure with numbered callouts,
   legend in contract order, no right rail). C's right column drifts toward Heracles' ruled ticket.
2. It is not the first idea: it draws the three objects the contract reads and numbers each field by the
   check that reads it. B's big diff plus stepper and C's till-paper receipt are the obvious moves.
3. Provenance is structure: contract, network, call, block and verdict are the title block.

## What the build changes from mockup A (the judge's five fixes)

1. The argument is at display size: `meta-llama/llama-3.3-70b-instruct` and `served-model` sit on the
   facing edges of the channel and receipt documents, on one baseline, joined by one straight leader that
   the magenta cut at 7 breaks. (Stolen from B.)
2. The verdict cell of the title block is the page's single filled element: magenta, `Refused,
   ModelMismatch() 0xa407e5f7`. Code identifiers are set in B612 Mono because B612's parentheses are
   square and read as `ModelMismatch[]`.
3. Callouts sit on the fields as numbers rather than long leader lines; the dashed loop for 8 is gone; the
   explanatory paragraph moves under the legend; the figure is tighter so the legend starts inside the
   first screen.
4. The receipt drops `requested-model`; it shows only what the contract compares (served model), the key and
   the body hashes.
5. Liveness: the call cell reads `eth_call redeemWithReceipt from 0x93e8…EE5A`, the block carries "read N s
   ago" and re-polls every 15 s, and a fourth drawn document shows the call and its raw revert.

Also taken: from B, the struck `1.00 USDG` at display size with "stays in channel 0, which holds 2.00";
from C, legend rows that carry the actual values and the headline "The receipt names another model. The
contract does not pay."

## Mobile (390)

Title block in two columns with the verdict first and full width; headline 36px; the figure stacks as channel
(pinned model), the broken magenta connector with 7, receipt (served model), then voucher and call; legend
rows full width.
