# UI rebuild verdict

Judge: demo-judge subagent, five rounds against the after-*.png screenshots in this folder and the Arbitrum portal references (docs/design-refs/arbitrum-portal plus live captures of portal.arbitrum.io earn, opportunity and bridge pages).

Final verdict (round 5): PASS. The judge found nothing left to change in the UI on Home, Channel or Verify at 1440 or 390.

How it got there: round 1 PASS WITH NITS (the mobile hero hid the served hash, an unlabelled channel picker, two empty states on Verify, copy implied payments had settled). Round 2 PASS WITH NITS (the right half of Verify was empty, channel 0's expiry was not shown on Home). Round 3 PASS WITH NITS ("(s)" plurals, a static "every channel is open" caption). Round 4 PASS WITH NITS (Verify step 3 was hidden until a report existed). Each round's nits were fixed in its own commit on ui-rebuild.

Weakest remaining point (outside UI scope): every channel shows Paid 0.00. No redeemWithReceipt payment has settled on this deployment, so the product shows the refusal but has never shown an accepted payment.

Refusal evidence: the Overview eth_calls Assay.redeemWithReceipt from provider 0x93e8...EE5A with web/src/lib/refusal-demo.json. It reverted with 0xa407e5f7, decoded as ModelMismatch, for example at block 313,745,681. Red check: making the caller the agent turned the panel into "Unexpected revert NotProvider() 0x3480e2b2", and the code was then restored.
