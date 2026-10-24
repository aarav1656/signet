// Builds web/lib/track-record.json from Robinhood Chain testnet (46630) and the mainnet Chainlink TSLA/USD feed (4663).
import {
  createPublicClient,
  decodeErrorResult,
  fallback,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { agentAccountAbi } from './account-abi.js';
import { rhcClient } from './chain.js';
import { summarize, venuePrice, type AgentRecord, type Attestation, type Refusal, type TokenInfo, type Trade, type TrackRecord } from './trackrecord.js';

const DEPLOY_BLOCK = 127033401n;
const WINDOW = 5_000_000n;
const EXPLORER = process.env.CHIRON_EXPLORER_URL ?? 'https://explorer.testnet.chain.robinhood.com';

/** Every AgentAccountFactory deployed on 46630 (docs/e2e/robinhood-testnet-agent-account.md); CHIRON_FACTORIES adds more. */
export const FACTORIES: Address[] = [
  '0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e',
  '0xB9F7eB234C2F562475668c1Dc9b6850f235373c3',
  '0x14103f1928AB34b45Cc376fF56fb59d798Deed03',
  ...((process.env.CHIRON_FACTORIES ?? '').split(',').filter(Boolean) as Address[]),
];

/** Testnet token (lowercase) -> decimals and role. The quote assets are valued at 1 USD. */
export const TOKENS: Record<string, TokenInfo> = {
  '0x3500daf0adce615a0bef108ff0751abb34b1ffcc': { decimals: 6, kind: 'quote' }, // TestUSDG
  '0x7e955252e15c84f5768b83c41a71f9eba181802f': { decimals: 6, kind: 'quote' }, // Paxos USDG
  '0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e': { decimals: 18, kind: 'stock' }, // TSLA Stock Token
};

/** Mainnet Chainlink "RHTSLA / USD" proxy on Robinhood Chain 4663, 8 decimals. */
export const TSLA_FEED: Address = '0x4A1166a659A55625345e9515b32adECea5547C38';

/** Workloads the repo documents by measurement (docs/e2e/robinhood-testnet-agent-account.md, contracts/deployments/46630.json). */
const WORKLOADS: Record<string, { label: string; workload: string }> = {
  '0x9dfd5de3a81d9aa78ab912b6a759c934ba79a20cf86ac57163d05ea4a5b364c8': { label: 'Chiron reference agent, CVM boot 1', workload: 'compose c3103c1d27fae754b023c075567b556625353098992493299535f1b276acad7c' },
  '0xeb2d9462332712d80fc18b2a8c07124096b55c3f94a8c8de6ff34692e9396829': { label: 'Chiron reference agent, CVM boot 2', workload: 'compose c3103c1d27fae754b023c075567b556625353098992493299535f1b276acad7c' },
  // agent-cvm/deployments/2026-10-24.json: the CVM whose measured compose pins STRATEGY_SHA256 of agent/strategies/demo-tsla.json.
  '0x69f33c1d9eb7b80eeac3869f52c56653dba6a7656148975e41aaaa2be133c97f': { label: 'Signet demo TSLA strategy, CVM boot 1', workload: 'compose 9f997c38f9754576002490da0740372e9510adca80d1719082d3bb8e31572606' },
  '0x993bd67c8e9de5d37d9af6ef41c5c5fdb53b113b8a2b666827e0e619f4978e9a': { label: 'Chiron operator agent', workload: 'image ttl.sh/chiron-agent-5ee4c1c6b5d1@sha256:01f1867126d58ee3e99cf1fef4fc8d253c68dbe5bed41db6eb3f33aa5a201463' },
  // agent-cvm/docker-compose.workload-b.yml and the one-value-changed variant, both on dstack-0.5.12 (not a dev image).
  '0x890d1a4c40e1e79cd7afdae1cd312413e69f5b159ac9ef0f45311521a86271a8': { label: 'Workload B', workload: 'compose 0e3d4c8ce0d296763092988aa025da9579b598bf043cc424624730c660d2db6c' },
  '0x399932395e8ef175193ae5550e77319c0d25a6b09dc12510f9e24de1f3cec387': { label: 'Workload B, modified (AGENT_REVISION=2)', workload: 'compose 9921659eee3a0e30ad0ae11c0c516bd5021d66a1b10d638b3810b29303792184' },
};

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export type Round = { roundId: bigint; answer: bigint; updatedAt: number };

export function mainnetClient(): PublicClient {
  const urls = (process.env.CHIRON_MAINNET_RPCS ?? 'https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com').split(',');
  return createPublicClient({ transport: fallback(urls.map((u) => http(u))) });
}

export function feedReader(m: PublicClient) {
  const read = async (fn: 'latestRoundData' | 'getRoundData', args: readonly bigint[] = []): Promise<Round> => {
    const r = (await m.readContract({ address: TSLA_FEED, abi: feedAbi, functionName: fn, args } as never)) as readonly [bigint, bigint, bigint, bigint, bigint];
    return { roundId: r[0], answer: r[1], updatedAt: Number(r[3]) };
  };
  const latest = () => read('latestRoundData');
  /** The round current at `ts`: the latest round with updatedAt <= ts. Round ids are contiguous, so gallop back then bisect. */
  const roundAt = async (ts: number, head?: Round): Promise<Round> => {
    const top = head ?? (await latest());
    if (top.updatedAt <= ts) return top;
    const at = (off: bigint) => read('getRoundData', [top.roundId - off]);
    let hi = 0n; // offset known to be after ts
    let step = 1n;
    let lo = 0n; // offset known to be at or before ts; 0 means not found yet
    while (lo === 0n) {
      const off = hi + step;
      let r: Round;
      try {
        r = await at(off);
      } catch {
        throw new Error(`Chainlink history does not reach back to ${new Date(ts * 1000).toISOString()} (round offset ${off} unreadable)`);
      }
      if (r.updatedAt <= ts) lo = off;
      else {
        hi = off;
        step *= 2n;
      }
    }
    while (lo - hi > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await at(mid)).updatedAt <= ts) lo = mid;
      else hi = mid;
    }
    const found = await at(lo);
    const next = await at(lo - 1n);
    if (found.updatedAt > ts || next.updatedAt <= ts) throw new Error(`round ${found.roundId} is not the round current at ${ts}`);
    return found;
  };
  return { latest, roundAt };
}

async function chunked<T>(head: bigint, fn: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let f = DEPLOY_BLOCK; f <= head; f += WINDOW) out.push(...(await fn(f, f + WINDOW - 1n > head ? head : f + WINDOW - 1n)));
  return out;
}

export async function discoverAccounts(c: PublicClient, head: bigint): Promise<Address[]> {
  const ev = parseAbiItem('event AccountCreated(address indexed account, address indexed owner, uint256 index)');
  const accounts = new Set<Address>();
  for (const factory of FACTORIES) {
    const logs = await chunked(head, (fromBlock, toBlock) => c.getLogs({ address: factory, event: ev, fromBlock, toBlock }));
    for (const l of logs) accounts.add(l.args.account as Address);
  }
  return [...accounts];
}

type RawTrade = { account: Address; tx: Hex; block: bigint; args: Record<string, unknown> };

type Admission = { agent: string; measurement: string; block: bigint; tx: Hex; account: Address };

/** One pass over an account's logs: its executed trades and every agent admission (key, measurement, block). */
async function accountHistory(c: PublicClient, account: Address, head: bigint) {
  const raw = await chunked(head, (fromBlock, toBlock) => c.getLogs({ address: account, fromBlock, toBlock }));
  const logs = parseEventLogs({ abi: agentAccountAbi, logs: raw, eventName: ['TradeExecuted', 'AgentRegistered'] });
  const trades: RawTrade[] = [];
  const admissions: Admission[] = [];
  for (const l of logs) {
    if (l.eventName === 'TradeExecuted') trades.push({ account, tx: l.transactionHash, block: l.blockNumber, args: l.args as Record<string, unknown> });
    else admissions.push({ agent: l.args.agent.toLowerCase(), measurement: l.args.measurement, block: l.blockNumber, tx: l.transactionHash, account });
  }
  return { trades, admissions };
}

/** Reverted agent-side calls to an account, from the explorer's address history, with the custom error decoded from the revert data. */
type ExplorerTx = { hash: Hex; block_number: number; raw_input: Hex; value: string; from?: { hash: string }; to?: { hash: string } };

/** Revert output of a mined revert: the explorer's decoded field, else its raw trace, else an eth_call replay at the parent block. */
async function revertData(c: PublicClient, t: ExplorerTx, indexed?: Hex): Promise<Hex> {
  if (indexed) return indexed;
  const trace = await fetch(`${EXPLORER}/api/v2/transactions/${t.hash}/raw-trace`).then((r) => (r.ok ? (r.json() as Promise<{ output?: string }>) : undefined)).catch(() => undefined);
  if (trace?.output && trace.output.length >= 10) return trace.output as Hex;
  try {
    await c.call({ account: t.from?.hash as Address, to: t.to?.hash as Address, data: t.raw_input, value: BigInt(t.value), blockNumber: BigInt(t.block_number) - 1n });
  } catch (e) {
    for (let cur = e as { data?: unknown; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) if (typeof cur.data === 'string' && cur.data.length >= 10) return cur.data as Hex;
  }
  throw new Error(`no revert data for ${t.hash}: explorer, raw trace and replay all came back empty`);
}

async function refusalsFor(c: PublicClient, account: Address, admissions: Admission[]): Promise<Refusal[]> {
  const out: Refusal[] = [];
  let query = '';
  for (let page = 0; page < 50; page++) {
    const r = await fetch(`${EXPLORER}/api/v2/addresses/${account}/transactions${query}`);
    if (!r.ok) throw new Error(`explorer ${r.status} for ${account}`);
    const j = (await r.json()) as { items: (ExplorerTx & { timestamp: string; status: string; method: string | null; revert_reason?: { raw?: Hex } | null })[]; next_page_params: Record<string, unknown> | null };
    for (const t of j.items) {
      if (t.status !== 'error' || !['registerAgent', 'execute', 'propose'].includes(t.method ?? '') || t.to?.hash.toLowerCase() !== account.toLowerCase()) continue;
      const data = await revertData(c, t, t.revert_reason?.raw);
      let reason = 'unknown';
      // the caller's most recent admission before the refusal names the workload that was refused
      let measurement: string | null = admissions.filter((a) => a.agent === t.from?.hash.toLowerCase() && a.block < BigInt(t.block_number)).at(-1)?.measurement ?? null;
      try {
        const e = decodeErrorResult({ abi: agentAccountAbi, data });
        reason = e.errorName;
        if (e.errorName === 'MeasurementNotApproved') measurement = String((e.args as readonly unknown[])[0]);
      } catch {
        // selector outside the account ABI stays "unknown"
      }
      out.push({ tx: t.hash, block: t.block_number, time: Math.floor(Date.parse(t.timestamp) / 1000), account, reason, method: t.method ?? '', measurement });
    }
    if (!j.next_page_params) return out;
    query = `?${new URLSearchParams(Object.fromEntries(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])))}`;
  }
  throw new Error(`explorer history for ${account} exceeded 50 pages`);
}

export async function buildTrackRecord(opts: { rpc?: string; log?: (s: string) => void } = {}): Promise<TrackRecord> {
  const log = opts.log ?? (() => {});
  const c = rhcClient(opts.rpc ?? process.env.CHIRON_RPC_URL);
  const feed = feedReader(mainnetClient());
  const head = await c.getBlockNumber();
  const accounts = await discoverAccounts(c, head);
  log(`factories ${FACTORIES.length}, accounts ${accounts.length}, head ${head}`);

  const hist = await Promise.all(accounts.map((a) => accountHistory(c, a, head)));
  const raws = hist.flatMap((h) => h.trades).sort((a, b) => Number(a.block - b.block));
  const refusals = (await Promise.all(accounts.map((a, i) => refusalsFor(c, a, hist[i].admissions)))).flat().sort((a, b) => a.block - b.block);
  const mark = await feed.latest();
  const markPrice = Number(mark.answer) / 1e8;

  const groups = new Map<string, { measurement: string; modelHash: string; trades: Trade[] }>();
  for (const r of raws) {
    const a = r.args as { tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint; agentMeasurement: string; servedModelHash: string };
    const time = Number((await c.getBlock({ blockNumber: r.block })).timestamp);
    const round = await feed.roundAt(time, mark);
    const base = { tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn.toString(), amountOut: a.amountOut.toString() };
    const trade: Trade = {
      tx: r.tx,
      block: Number(r.block),
      time,
      account: r.account,
      ...base,
      priceUsdAtTrade: Number(round.answer) / 1e8,
      venuePriceUsd: venuePrice(base, TOKENS),
      oracle: { roundId: round.roundId.toString(), updatedAt: round.updatedAt, answer: round.answer.toString() },
      modelHash: a.servedModelHash,
    };
    const key = `${a.agentMeasurement}:${a.servedModelHash}`;
    const g = groups.get(key) ?? { measurement: a.agentMeasurement, modelHash: a.servedModelHash, trades: [] };
    g.trades.push(trade);
    groups.set(key, g);
    log(`trade ${r.tx} block ${r.block} ${a.agentMeasurement.slice(0, 10)} oracle ${trade.priceUsdAtTrade} venue ${trade.venuePriceUsd.toFixed(2)}`);
  }

  const agents: AgentRecord[] = [...groups.values()].map((g) => {
    const known = WORKLOADS[g.measurement.toLowerCase()];
    const s = summarize(g.trades, TOKENS, markPrice);
    return {
      measurement: g.measurement,
      modelHash: g.modelHash,
      label: known?.label ?? `Agent ${g.measurement.slice(0, 10)}`,
      workload: known?.workload ?? null,
      accounts: [...new Set(g.trades.map((t) => t.account))],
      trades: g.trades,
      ...s,
      tradeCount: g.trades.length,
      firstTrade: g.trades[0].time,
      lastTrade: g.trades[g.trades.length - 1].time,
    };
  });

  const byMeasurement = new Map<string, Admission[]>();
  for (const a of hist.flatMap((h) => h.admissions).sort((x, y) => Number(x.block - y.block))) byMeasurement.set(a.measurement, [...(byMeasurement.get(a.measurement) ?? []), a]);
  const attestations: Attestation[] = [];
  for (const [measurement, adm] of byMeasurement) {
    const known = WORKLOADS[measurement.toLowerCase()];
    const first = adm[0];
    attestations.push({
      measurement,
      label: known?.label ?? `Agent ${measurement.slice(0, 10)}`,
      workload: known?.workload ?? null,
      agents: [...new Set(adm.map((a) => a.agent))],
      accounts: [...new Set(adm.map((a) => a.account))],
      admissions: adm.length,
      firstAdmission: { tx: first.tx, block: Number(first.block), time: Number((await c.getBlock({ blockNumber: first.block })).timestamp), account: first.account },
      tradeCount: agents.filter((g) => g.measurement === measurement).reduce((n, g) => n + g.tradeCount, 0),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    chainId: 46630,
    block: Number(head),
    pricing: {
      feed: `Chainlink RHTSLA / USD ${TSLA_FEED} on Robinhood Chain mainnet 4663`,
      feedChainId: 4663,
      decimals: 8,
      mark: { roundId: mark.roundId.toString(), updatedAt: mark.updatedAt, priceUsd: markPrice },
      quoteAssetsUsd: 1,
      note: 'Stock Token legs are priced from the mainnet Chainlink round current at each trade block time (round id recorded per trade). Quote assets (TestUSDG, USDG) count 1 USD. pnlUsd marks the net position at the latest round; pnlAtTradeUsd values each trade at its own round.',
    },
    agents,
    attestations,
    refusals,
  };
}
