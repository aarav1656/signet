# Chiron UI v2: phase 4 verdict

**PASS** (round 3, confirmed by a second fresh critic on the final screenshots).

Every critic was a fresh `demo-judge` agent that never saw the build. Each got the after screenshots of every
route at 1440x900 and 390x844 (first screens and full pages, plus the "Inspect the call" disclosure opened),
the north star and secondary reference screenshots, the rejected previous UI, the locked `web/DESIGN.md`, the
identity registry, and the current screens of the three other products in this workspace.

## Rounds

| Round | Verdict | What failed |
|---|---|---|
| 1 | FAIL | Channels and Verify were heading, paragraph, forms (generic); Verify first screen had empty values, a shell command and an uppercased address button; mono punctuation spacing; two block numbers on one screen |
| 2 | FAIL | STATE row overflowed on Channels at 390; the refusal visual lost its leader at 390; Verify first screen over three figures; headline-left, button-right top row shared a skeleton with a sibling; hero documents did not read as documents |
| 3 | PASS | Follow-ups only (applied after the verdict: the orphan circled 7 became the cut label "no match, check 7 of 9"; key intro moved under the documents; strike clipped to the amount) |
| Confirmation, final screenshots | PASS | Follow-ups below |

## Final tell scores (confirmation critic)

| Tell | Score |
|---|---|
| Purple gradients | absent |
| Inter / Roboto / Arial / system fonts | absent (Red Hat Display, B612) |
| Cards in cards | absent |
| Big rounded icons above headings | absent |
| Thick coloured borders on rounded cards | absent (1px ink, radius 0) |
| Glassmorphism, glow, neon, cyan on dark | absent |
| Monospace hacker vibe | absent (mono only on truncated hex; code names in B612 bold) |
| Sparklines, elastic motion as fake impact | absent in stills |
| Big-metric template | absent |
| Status pills everywhere | absent (one magenta verdict cell; states are words) |
| Huge display type with no negative tracking | absent |
| Same-family colour goo | absent (ink, graphite, one magenta) |
| Unnecessary detail | present, below the fold only: the legacy `redeem()` form on a receipt-only channel; byte offsets in "How registration works" |

Generic test: "No. The folded-corner documents, the leader cut in magenta and the callouts numbered in contract
order come from this product's content." Sibling check: not a sibling of Payday, Janus or Heracles.

**Weakest remaining point (confirmation critic):** on the 390 Overview first screen the magenta "Payment
refused" band is the first strong element and `served-model` sits just below the fold, so a phone reader sees the
verdict and the pinned model before the mismatch that explains it.

Follow-ups named by the critic, not done: collapse the legacy `redeem()` form on receipt-only channels; give the
Verify "Registering" title cell a real value or drop it; restore the USDG gloss on the channel document at 390;
make Verify button states consistent; record a motion capture, since stills cannot prove the motion spec.
Out of scope for this gate, noted by two critics: no `redeemWithReceipt` payment has settled onchain yet
(channel 0 paid is 0.00 USDG).

## Cold-reader test (fresh agent, first-screen screenshots only, no other context)

Final screenshots, verbatim:

> (a) It's a live demo showing a smart contract ("Assay") that refuses to pay an AI provider unless a sealed
> hardware gateway signs a receipt confirming the specific model that answered the call.
>
> (b) Developers or teams building agents that pay per-API-call to AI model providers on Arbitrum, who need proof
> they got the model they paid for.
>
> (c) I'd click "Open a channel pinned to a model," expecting a flow to lock USDG funds to a specific model (e.g.,
> a new payment channel setup), since the current demo channel already shows a failed/refused payment example.
>
> (d) Unclear points: what "TEE (Intel TDX)" verification concretely proves versus the disclaimer that the receipt
> "does not prove which weights ran" seems contradictory. Also "CHECK 7 OF 9" and "Inspect the call" hint at a
> 9-step validation process not shown, and it's not clear if this is a real testnet transaction or a
> simulated/read-only demo (text says "nothing was sent").

Against the truth: (a), (b) and (c) are correct. "Open a channel pinned to a model" goes to the Channels page,
whose first action opens a USDG channel pinned to a model. (d) names real gaps: the TEE gloss and the receipt
caveat read as a tension to a newcomer, and "read-only demo call" is stated in small text.

Earlier rounds, verbatim (a) answers: round 1 "It verifies whether an AI agent's payment to an LLM provider
should go through, by checking a cryptographic receipt against the model the payment channel was opened for."
Round 2 "Chiron shows an on-chain payment gateway that refuses to pay an AI provider when the model that actually
answered doesn't match the model the payment channel was opened for." Round 3 "It's a demo dashboard for an
on-chain payment-channel contract that only releases funds to an AI provider when a signed receipt from a sealed
TEE gateway confirms the promised model actually answered the call."

## Evidence outside the critics

- Zero app console errors on every route at 1440 and 390 (the only entries were a wallet extension's
  `Cannot redefine property: ethereum`, excluded by the brief). The same capture caught a `favicon.ico` 404,
  which was then fixed, so the check can fail.
- Loud failure, red then green: pointing the committed refusal input's caller at the agent address made the
  live call revert `NotProvider()` (0x3480e2b2); the page showed the inverted alarm row, the verdict cell turned
  ink with "Refused for another reason", the caption said the refusal is not happening, and the amount was not
  struck. Restoring the file brought back `ModelMismatch()` 0xa407e5f7.
- `npm run build` passes. No contract call, ABI, hook signature or money path changed (diffed against the
  pre-rebuild commit: every `readContract`, `writeContractAsync`, `simulateContract`, `call` and
  `signTypedData` is byte-identical apart from indentation).
