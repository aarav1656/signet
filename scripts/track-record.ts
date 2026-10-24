// Usage: cd mcp && npx tsx ../scripts/track-record.ts   (writes web/lib/track-record.json)
// Reads Robinhood Chain testnet 46630 and the mainnet Chainlink TSLA/USD feed. No keys needed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildTrackRecord } from '../mcp/src/trackrecord-chain.ts';

const out = new URL('../web/lib/track-record.json', import.meta.url);
const tr = await buildTrackRecord({ log: (s) => console.error(s) });
if (tr.agents.length === 0) throw new Error('no TradeExecuted events found: refusing to write an empty track record');
mkdirSync(new URL('./', out), { recursive: true });
writeFileSync(out, `${JSON.stringify(tr, null, 2)}\n`);
console.log(`wrote ${out.pathname}: ${tr.agents.length} agent groups, ${tr.agents.reduce((n, a) => n + a.tradeCount, 0)} trades, ${tr.refusals.length} refusals, block ${tr.block}`);
for (const a of tr.agents) console.log(`${a.measurement.slice(0, 12)} model ${a.modelHash.slice(0, 10)} trades ${a.tradeCount} pnl ${a.pnlUsd.toFixed(4)} ret ${a.returnPct.toFixed(2)}% atTrade ${a.pnlAtTradeUsd.toFixed(4)}`);
