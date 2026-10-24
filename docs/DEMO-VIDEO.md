# Signet: 90-second demo video

Total 90 seconds: problem 10, the proof 30, follow flow 30, why Robinhood Chain 10, ask 10. Every shot is a real screen. Narration is about 215 words, read at a calm pace.

## Recording plan

Tool: Recordly (skill `recordly`) driving the live app over CDP for the cursor paths and auto-zoom, plus plain screen capture for the explorer tabs. Record in the `deepsurge` browser profile, one tab per screen, 1920x1080, light cursor smoothing, no webcam. Pre-open these tabs so no loading shows on camera:

Tab A: https://chiron-receipts.vercel.app (the Signet leaderboard: one strategy row with its compose hash, two measurements, three trades and the return; the agent profile behind it holds the Follow panel)
Tab B: https://explorer.testnet.chain.robinhood.com/tx/0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03 (attested trade, Logs tab)
Tab C: https://explorer.testnet.chain.robinhood.com/tx/0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8 (refusal, revert reason)
Tab D: https://chiron-receipts.vercel.app/verify
Tab E: contracts/src/AgentAccount.sol at registerAgent, in an editor (lines 261-281)

Rules: record narration separately in the founder's voice (voiceb or live read), then lay it over the footage and trim each shot to its narration beat so there is no dead air. Footage must not be sped up where a hash or revert reason is being read. Do a dry run first and confirm every tab shows data, not a loading state. If the keeper has let the agent key lapse, the agent panel turns red: wait for re-admission (keeper checks every 30 minutes) before recording.

## Script

Shot 1 (0:00 to 0:10) Problem. Screen: Tab A, the leaderboard row (strategy, its measurements, trades, return, chain check), then the agent profile with its receipt timeline.
Narration: "Anyone can post a track record for an AI trading agent. Nobody can tell which code made it. The creator can swap the strategy and keep the name. And to prove it, they would have to publish the strategy and lose it."

Shot 2 (0:10 to 0:25) The proof, the trade. Screen: Tab B. Open the Logs tab, zoom on the TradeExecuted event, highlight agentMeasurement and servedModelHash.
Narration: "Signet fixes that. The agent runs inside an Intel TDX enclave, and its strategy text is sealed config pinned by hash in the measured image. This is a real trade on Robinhood Chain testnet: the agent bought TSLA with Paxos USDG. The event names the exact enclave measurement and the model hash behind it."

Shot 3 (0:25 to 0:40) The proof, the refusal. Screen: Tab C. Zoom on the failed status and the decoded error MeasurementNotApproved.
Narration: "Now a different workload. A genuine TDX quote, from code the follower never approved. The chain refuses it. A new measurement is a new agent, and it starts with no record."

Shot 4 (0:40 to 0:48) How it is checked. Screen: Tab E, scroll registerAgent, cursor on the verifier.verify line and the approvedMeasurement check.
Narration: "The quote is verified onchain, in Stylus, against Intel's root, in the same transaction that admits the key."

Shot 5 (0:48 to 1:00) Follow flow, set the terms. Screen: Tab A, the agent profile's Follow panel: the steps it lists (unapprove every other measurement, approve this one, set caps). Do not submit a new tx on camera if the wallet is not funded; show the step list and the existing mandate section with the caps, approval threshold and approved measurement.
Narration: "A follower owns an account that holds their own tokens. Following leaves exactly one measurement approved, and they set caps. The agent can only trade for code they admitted."

Shot 6 (1:00 to 1:10) Follow flow, the safety net. Screen: Tab A gate log: the rows showing a pending proposal and the refused calls with decoded errors.
Narration: "Big trades wait for the follower to approve. Over-cap trades revert. Even an admitted agent cannot spend past the limits."

Shot 7 (1:10 to 1:15) Follow flow, revoke. Screen: Tab A mandate section with the approved measurement list; cursor hovers the unapprove control.
Narration: "Unapprove the measurement and the agent is out in the same transaction."

Shot 8 (1:15 to 1:25) Why Robinhood Chain. Screen: Tab D (/verify), then Tab A balances showing the TSLA Stock Token.
Narration: "This needs Stock Tokens, canonical Uniswap v4, and Stylus for the heavy quote verification. Robinhood Chain has all three, and the account even pauses an agent during a Stock Token split."

Shot 9 (1:25 to 1:30) Ask. Screen: Tab A top, URL bar visible.
Narration: "Signet. A record you can verify, a strategy you keep. Try it at chiron-receipts dot vercel dot app."

## Pre-flight checks before recording

1. Open each tab and confirm a non-empty state: the gate log lists trades, the agent panel shows a live key-expiry countdown, tx pages show status.
2. Confirm the attested trade page shows TradeExecuted and the refusal page shows a failed status. If an explorer layout hides the decoded error, show the same error in the app's refusal row on Tab A.
3. After the cut, play it back once with sound off: each shot should still read from the screen alone.
4. Shot 5 and 7 show existing state. Do not claim a live signature happened on camera unless one did.
