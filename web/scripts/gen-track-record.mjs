// Builds web/lib/track-record.json from Robinhood Chain testnet (46630): every TradeExecuted event of every
// account the factories created, grouped by the TDX workload measurement the trade recorded, plus the mined
// registerAgent calls the accounts refused with MeasurementNotApproved. Nothing is typed in by hand.
import { readFileSync, writeFileSync } from 'node:fs';
import { inWindows } from '../src/lib/logs.ts';
import { createPublicClient, http, formatUnits, getAddress, erc20Abi } from 'viem';

const here = new URL('.', import.meta.url);
const src = (p) => readFileSync(new URL(p, here), 'utf8');
const abiOf = (file, name) => JSON.parse(src(`../src/abi/${file}`).match(new RegExp(`${name} = (\\[.*?\\]) as const`, 's'))[1]);
const rhc = src('../src/lib/rhc.generated.ts');
const list = (k) => JSON.parse(rhc.match(new RegExp(`export const ${k} = (\\[.*?\\])`, 's'))[1]);
const FACTORIES = list('FACTORIES');
const DEPLOY_BLOCK = BigInt(rhc.match(/RHC_DEPLOY_BLOCK = (\d+)n/)[1]);
const REFUSALS = list('RHC_REFUSAL_TXS');
const accountAbi = abiOf('AgentAccount.generated.ts', 'accountAbi');
const factoryAbi = abiOf('AgentAccount.generated.ts', 'factoryAbi');
const MODEL = 'meta-llama/llama-3.3-70b-instruct, served as llama3-3-70b';

const c = createPublicClient({ transport: http(process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com') });
const head = await c.getBlockNumber();
const events = (address, abi, eventName) => inWindows(DEPLOY_BLOCK, head, (fromBlock, toBlock) => c.getContractEvents({ address, abi, eventName, fromBlock, toBlock }));

const created = (await Promise.all(FACTORIES.map((address) => events(address, factoryAbi, 'AccountCreated')))).flat();
const accounts = [...new Set(created.map((l) => getAddress(l.args.account)))];

const trades = (await Promise.all(accounts.map((address) => events(address, accountAbi, 'TradeExecuted')))).flat();
const blocks = new Map();
for (const b of new Set(trades.map((l) => l.blockNumber))) blocks.set(b, (await c.getBlock({ blockNumber: b })).timestamp);

const dec = new Map();
const decimals = async (t) => {
  if (!dec.has(t)) dec.set(t, await c.readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }));
  return dec.get(t);
};
const symbol = (t) => c.readContract({ address: t, abi: erc20Abi, functionName: 'symbol' });

// The dollar side has 6 decimals; the other side is the Stock Token.
const rows = [];
for (const l of trades) {
  const { tokenIn, tokenOut, amountIn, amountOut, agentMeasurement, servedModelHash } = l.args;
  const [din, dout] = [await decimals(tokenIn), await decimals(tokenOut)];
  const buy = din === 6 && dout !== 6;
  const usd = Number(formatUnits(buy ? amountIn : amountOut, 6));
  const stock = Number(formatUnits(buy ? amountOut : amountIn, buy ? dout : din));
  rows.push({
    measurement: agentMeasurement,
    t: {
      tx: l.transactionHash, block: Number(l.blockNumber), time: Number(blocks.get(l.blockNumber)), account: getAddress(l.address),
      tokenIn: await symbol(tokenIn), tokenOut: await symbol(tokenOut),
      amountIn: formatUnits(amountIn, din), amountOut: formatUnits(amountOut, dout),
      priceUsdAtTrade: stock > 0 ? usd / stock : null, modelHash: servedModelHash, side: buy ? 'buy' : 'sell', usd, stock,
    },
  });
}
rows.sort((a, b) => a.t.block - b.t.block);
const mark = rows.at(-1)?.t.priceUsdAtTrade ?? null;

const agents = [...new Set(rows.map((r) => r.measurement))]
  .map((measurement, i) => {
    const own = rows.filter((r) => r.measurement === measurement).map((r) => r.t);
    const net = own.reduce((s, t) => s + (t.side === 'buy' ? 1 : -1) * t.stock, 0);
    const cash = own.reduce((s, t) => s + (t.side === 'buy' ? -1 : 1) * t.usd, 0);
    const spent = own.filter((t) => t.side === 'buy').reduce((s, t) => s + t.usd, 0);
    const pnlUsd = mark === null ? null : cash + net * mark;
    return {
      measurement,
      modelHash: own.at(-1).modelHash,
      label: `Chiron operator agent ${i + 1}`,
      model: MODEL,
      accounts: [...new Set(own.map((t) => t.account))],
      trades: own.map(({ side, usd, stock, ...t }) => t),
      pnlUsd,
      returnPct: spent > 0 && pnlUsd !== null ? (pnlUsd / spent) * 100 : null,
      markPriceUsd: mark,
      tradeCount: own.length,
      firstTrade: own[0].time,
      lastTrade: own.at(-1).time,
    };
  })
  .sort((a, b) => b.lastTrade - a.lastTrade);

// The RPC prunes historical state, so a revert cannot be replayed; Blockscout decodes the mined revert.
const EXPLORER = 'https://explorer.testnet.chain.robinhood.com';
const refusals = [];
for (const hash of REFUSALS) {
  const [tx, rc, info] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash }), fetch(`${EXPLORER}/api/v2/transactions/${hash}`).then((r) => r.json())]);
  const call = info.revert_reason?.method_call ?? '';
  if (rc.status !== 'reverted' || !call.startsWith('MeasurementNotApproved')) continue;
  refusals.push({
    tx: hash, block: Number(rc.blockNumber), time: Number((await c.getBlock({ blockNumber: rc.blockNumber })).timestamp),
    account: getAddress(tx.to), reason: 'MeasurementNotApproved', measurement: info.revert_reason.parameters[0].value,
  });
}

const out = { generatedAt: new Date().toISOString(), chainId: 46630, block: Number(head), agents, refusals };
writeFileSync(new URL('../lib/track-record.json', here), JSON.stringify(out, null, 2) + '\n');
console.log(`accounts ${accounts.length}, trades ${rows.length}, agents ${agents.length}, refusals ${refusals.length}, block ${head}`);
for (const a of agents) console.log(a.measurement.slice(0, 12), a.tradeCount, a.pnlUsd, a.returnPct, a.accounts.length);
