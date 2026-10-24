# Deck image sources

Every screenshot was captured on 2026-10-24 by `deck/capture.py` (a background tab in the signed-in bhn deepsurge profile, no focus change) and cut to slide size by `deck/make_images.py` from the full captures in `deck/img/raw/`. Highlights are drawn in the page DOM before capture, so the text under them is the page's own.

| Image | Slide | URL |
|---|---|---|
| x-robinhood-agents.png | 2 | https://x.com/RobinhoodApp/status/2105074572722679839 (posted 2026-09-29 23:17 UTC) |
| newsroom-head.png | 2 | https://robinhood.com/us/en/newsroom/hood-summit-2026/ |
| newsroom-150k.png | 2 | https://robinhood.com/us/en/newsroom/hood-summit-2026/ ("over 150,000 customers have opened agentic trading accounts" highlighted) |
| newsroom-audit.png | 3 | https://robinhood.com/us/en/newsroom/hood-summit-2026/ ("Robinhood does not control, supervise, monitor, recommend, or audit agents." highlighted) |
| tile-metazet.png | 4 | https://x.com/Meta_ZET/status/2110788179754094667 |
| tile-dee_fvg.png | 4 | https://x.com/dee_fvg/status/2110224683421389043 |
| tile-goddyfx01.png | 4 | https://x.com/goddyfx01/status/2112079611316289704 |
| tile-solst1ne.png | 4 | https://x.com/SolSt1ne/status/2111170397869904275 |
| tile-whitman.png | 4 | https://x.com/WhitmanXAI/status/2097327801867395103 |
| tile-eastenray.png | 4 | https://x.com/EaStEnRaY1/status/2111826774179106837 |
| architecture.png | 5 | generated with archify from `architecture.archify.json` (9 of 9 showcase checks, 0 errors, 0 warnings), screenshot of the HTML at 1920x1080 |
| phala-verified.png | 6 | https://proof.t16z.com/reports/36dc782d6017f870bd1274c2aa20d3e9fe9a2706b01a89ab02b5974f6de4c702 (quote from POST https://e45234c10954cbcf891ef414999e89a4b98dd090-8080.dstack-pha-prod5.phala.network/quote, MRCONFIG compose hash highlighted) |
| explorer-admit.png | 6 | https://explorer.testnet.chain.robinhood.com/tx/0x5fdc4acb64d8f1dddc9042c9101c652f87f7483cc1163d0c878b431c44ce965c |
| explorer-trade-logs.png | 7 | https://explorer.testnet.chain.robinhood.com/tx/0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03?tab=logs |
| explorer-refusal.png | 8 | https://explorer.testnet.chain.robinhood.com/tx/0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8 |
| leaderboard-live.png | 9 | https://signet-agents.vercel.app (record read at block 141,782,630) |

Each X post was confirmed to exist with `curl https://api.fxtwitter.com/<user>/status/<id>` before capture (text, date and media type read from the post).
