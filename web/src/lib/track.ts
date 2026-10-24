import { formatUnits, isAddress, isHex, type Address, type Hex } from 'viem';
import { symbolOf } from './venue';
import raw from '../../lib/track-record.json';

export type TrackTrade = {
  tx: Hex;
  block: number;
  time: number;
  account: Address;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  priceUsdAtTrade: number | null;
  modelHash: Hex;
  /** The workload measurement of the boot that traded. */
  measurement: Hex;
  /** The price feed round a trade was valued at, when the record carries one. */
  oracle?: { roundId: string };
};

export type TrackAdmission = { tx: Hex; block: number; time: number; account: Address };

export type TrackAgent = {
  measurement: Hex;
  modelHash: Hex;
  label: string;
  /** The compose hash of the workload this boot ran: the stable identity of a strategy, since the measurement changes per boot. */
  compose?: Hex;
  /** The Verifier's first admission of a key under this measurement. */
  admission?: TrackAdmission;
  deployedUsd: number | null;
  accounts: Address[];
  trades: TrackTrade[];
  pnlUsd: number | null;
  returnPct: number | null;
  markPriceUsd: number | null;
  firstTrade: number;
  lastTrade: number;
};

export type TrackRefusal = { tx: Hex; block: number; time: number; account: Address; reason: string; measurement: Hex; method?: string };

/** How the record values positions: the feed, the round of the latest mark and the price it gave. */
export type TrackPricing = { feed: string; markPriceUsd: number | null; roundId?: string; updatedAt?: number; note?: string };

export type TrackRecord = {
  generatedAt: string;
  chainId: number;
  block: number;
  pricing?: TrackPricing;
  agents: TrackAgent[];
  refusals: TrackRefusal[];
  /** Measurements the Verifier admitted on some account at least once. A refusal of one of these was refused before its owner approved it. */
  admitted: Hex[];
};

const hex32 = (x: unknown): x is Hex => typeof x === 'string' && isHex(x, { strict: true }) && x.length === 66;
const num = (x: unknown, what: string): number => {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`track record: ${what} is not a number`);
  return n;
};
/** Unix seconds from seconds, milliseconds or an ISO timestamp. */
const seconds = (x: unknown, what: string): number => {
  if (typeof x === 'string' && Number.isNaN(Number(x))) {
    const ms = Date.parse(x);
    if (Number.isNaN(ms)) throw new Error(`track record: ${what} is not a time`);
    return Math.floor(ms / 1000);
  }
  const n = num(x, what);
  return n > 1e11 ? Math.floor(n / 1000) : n;
};
const COMPOSE = /^compose (?:0x)?([0-9a-f]{64})$/i;
/** The compose hash a workload string carries ("compose <64 hex>"), or undefined for a workload identified another way. */
export const composeOf = (workload: unknown): Hex | undefined => {
  const m = typeof workload === 'string' ? COMPOSE.exec(workload.trim()) : null;
  return m ? (`0x${m[1].toLowerCase()}` as Hex) : undefined;
};
const DECIMALS: Record<string, number> = { USDG: 6, TSLA: 18 };
/** An amount as a decimal string. A whole number of 7 or more digits is base units and is scaled by the token's decimals. */
export function decimalAmount(raw: unknown, symbol: string): string {
  const s = String(raw);
  const d = DECIMALS[symbol];
  return d !== undefined && /^\d{7,}$/.test(s) ? formatUnits(BigInt(s), d) : s;
}
const numOrNull = (x: unknown, what: string): number | null => (x === null || x === undefined ? null : num(x, what));

/** Read the track record's JSON into the shapes the app renders. A malformed record throws; nothing is defaulted. */
export function parseTrack(input: unknown): TrackRecord {
  const o = input as Record<string, unknown>;
  if (!o || typeof o !== 'object' || !Array.isArray(o.agents) || !Array.isArray(o.refusals)) throw new Error('track record: agents and refusals are required');
  if (o.chainId !== 46630) throw new Error(`track record: chainId ${String(o.chainId)} is not 46630`);
  const admissions = new Map<string, TrackAdmission>();
  const admitted: Hex[] = [];
  for (const x of Array.isArray(o.attestations) ? (o.attestations as Record<string, unknown>[]) : []) {
    const f = x.firstAdmission as Record<string, unknown> | undefined;
    if (hex32(x.measurement) && Number(x.admissions) > 0) admitted.push(x.measurement.toLowerCase() as Hex);
    if (hex32(x.measurement) && f && hex32(f.tx) && isAddress(String(f.account))) admissions.set(x.measurement.toLowerCase(), { tx: f.tx, block: num(f.block, 'admission block'), time: seconds(f.time, 'admission time'), account: f.account as Address });
  }
  const agents = (o.agents as Record<string, unknown>[]).map((a): TrackAgent => {
    if (!hex32(a.measurement)) throw new Error('track record: agent measurement is not bytes32');
    const measurement = a.measurement;
    const trades = (Array.isArray(a.trades) ? (a.trades as Record<string, unknown>[]) : []).map((t): TrackTrade => {
      if (!hex32(t.tx) || !hex32(t.modelHash) || !isAddress(String(t.account))) throw new Error('track record: a trade has a malformed tx, model hash or account');
      const [tokenIn, tokenOut] = [symbolOf(String(t.tokenIn)), symbolOf(String(t.tokenOut))];
      return {
        tx: t.tx, block: num(t.block, 'trade block'), time: seconds(t.time, 'trade time'), account: t.account as Address,
        tokenIn, tokenOut, amountIn: decimalAmount(t.amountIn, tokenIn), amountOut: decimalAmount(t.amountOut, tokenOut),
        priceUsdAtTrade: numOrNull(t.priceUsdAtTrade, 'trade price'), modelHash: t.modelHash, measurement,
        ...(t.oracle && typeof t.oracle === 'object' ? { oracle: { roundId: String((t.oracle as Record<string, unknown>).roundId) } } : {}),
      };
    });
    trades.sort((x, y) => x.block - y.block);
    const first = trades[0]?.time ?? seconds(a.firstTrade, 'firstTrade');
    const last = trades.at(-1)?.time ?? seconds(a.lastTrade, 'lastTrade');
    return {
      measurement: a.measurement,
      modelHash: hex32(a.modelHash) ? a.modelHash : (trades.at(-1)?.modelHash as Hex),
      label: typeof a.label === 'string' && a.label ? a.label : `Agent ${a.measurement.slice(2, 8)}`,
      ...(composeOf(a.workload) ? { compose: composeOf(a.workload) } : {}),
      ...(admissions.has(measurement.toLowerCase()) ? { admission: admissions.get(measurement.toLowerCase()) } : {}),
      deployedUsd: numOrNull(a.deployedUsd, 'deployedUsd'),
      accounts: Array.isArray(a.accounts) ? (a.accounts as Address[]) : [...new Set(trades.map((t) => t.account))],
      trades,
      pnlUsd: numOrNull(a.pnlUsd, 'pnlUsd'),
      returnPct: numOrNull(a.returnPct, 'returnPct'),
      markPriceUsd: numOrNull(a.markPriceUsd, 'markPriceUsd'),
      firstTrade: first,
      lastTrade: last,
    };
  });
  const refusals = (o.refusals as Record<string, unknown>[]).map((r): TrackRefusal => {
    if (!hex32(r.tx) || !hex32(r.measurement) || !isAddress(String(r.account))) throw new Error('track record: a refusal has a malformed tx, measurement or account');
    return { tx: r.tx, block: num(r.block, 'refusal block'), time: seconds(r.time, 'refusal time'), account: r.account as Address, reason: String(r.reason), measurement: r.measurement, ...(typeof r.method === 'string' ? { method: r.method } : {}) };
  });
  const p = o.pricing as Record<string, unknown> | undefined;
  const mark = p?.mark as Record<string, unknown> | undefined;
  const pricing: TrackPricing | undefined =
    p && typeof p.feed === 'string'
      ? {
          feed: p.feed,
          markPriceUsd: numOrNull(mark?.priceUsd, 'mark price'),
          ...(mark?.roundId !== undefined ? { roundId: String(mark.roundId) } : {}),
          ...(mark?.updatedAt !== undefined ? { updatedAt: num(mark.updatedAt, 'mark time') } : {}),
          ...(typeof p.note === 'string' ? { note: p.note } : {}),
        }
      : undefined;
  return { generatedAt: String(o.generatedAt), chainId: 46630, block: num(o.block, 'block'), ...(pricing ? { pricing } : {}), agents, refusals, admitted };
}

/** The file is data from another process: an unreadable one empties the board and says why instead of blanking the app. */
function load(): { track: TrackRecord; error?: string } {
  try {
    return { track: parseTrack(raw) };
  } catch (e) {
    return { track: { generatedAt: '', chainId: 46630, block: 0, agents: [], refusals: [], admitted: [] }, error: e instanceof Error ? e.message : String(e) };
  }
}
const loaded = load();
export const TRACK: TrackRecord = loaded.track;
export const TRACK_ERROR: string | undefined = loaded.error;

/** Highest return first; an agent with no marked return ranks below every marked one, then by trade count. */
export function ranked(agents: readonly TrackAgent[]): TrackAgent[] {
  return [...agents].sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity) || b.trades.length - a.trades.length || b.lastTrade - a.lastTrade);
}

export const agentByMeasurement = (agents: readonly TrackAgent[], m: string): TrackAgent | undefined => agents.find((a) => a.measurement.toLowerCase() === m.toLowerCase());

/** "+1.69%", "-0.40%", "0.00%"; "unmarked" when no price marks the position. */
export function fmtPct(p: number | null): string {
  if (p === null) return 'unmarked';
  const s = Math.abs(p).toFixed(2);
  return p > 0 && s !== '0.00' ? `+${s}%` : p < 0 && s !== '0.00' ? `-${s}%` : '0.00%';
}

/** The price a trade cleared at on the pool, from its own amounts: dollars paid or received per Stock Token. */
export function executedPriceUsd(t: Pick<TrackTrade, 'tokenIn' | 'tokenOut' | 'amountIn' | 'amountOut'>): number | null {
  const buy = t.tokenIn === 'USDG';
  const [usd, stock] = buy ? [Number(t.amountIn), Number(t.amountOut)] : [Number(t.amountOut), Number(t.amountIn)];
  return Number.isFinite(usd) && Number.isFinite(stock) && stock > 0 ? usd / stock : null;
}

/** "+$0.05", "-$1.20"; "unmarked" when there is no figure. */
export const fmtSignedDollars = (v: number | null) => (v === null ? 'unmarked' : `${v > 0 ? '+' : ''}${fmtDollars(v)}`);

export const fmtDollars = (v: number | null) => (v === null ? 'unmarked' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** A decimal string for display: two places from 1 up, up to six below ("0.003910026278631909" is "0.00391"). */
export function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', n >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 6 });
}

/** One strategy: every boot that ran the same compose hash. A boot has its own measurement; the compose hash is what stays. */
export type Strategy = {
  /** The compose hash, or the measurement for a workload that carries no compose hash. The profile route takes this. */
  id: string;
  compose?: Hex;
  label: string;
  boots: TrackAgent[];
  trades: TrackTrade[];
  accounts: Address[];
  modelHashes: Hex[];
  pnlUsd: number | null;
  returnPct: number | null;
  firstTrade: number;
  lastTrade: number;
};

/** "Chiron reference agent, CVM boot 2" is boot 2 of "Chiron reference agent". */
export const strategyLabel = (label: string): string => label.replace(/[,:]?\s+(?:CVM\s+)?boot\s+\d+$/i, '');

/** Boots that share a compose hash are one strategy. Return is the strategy's profit over the dollars its boots put to work; it is unmarked unless every boot is marked. */
export function groupByCompose(agents: readonly TrackAgent[]): Strategy[] {
  const byId = new Map<string, TrackAgent[]>();
  for (const a of agents) {
    const id = a.compose ?? a.measurement;
    byId.set(id.toLowerCase(), [...(byId.get(id.toLowerCase()) ?? []), a]);
  }
  return [...byId.values()].map((boots): Strategy => {
    boots.sort((x, y) => x.firstTrade - y.firstTrade);
    const trades = boots.flatMap((b) => b.trades).sort((x, y) => x.block - y.block);
    const marked = boots.every((b) => b.pnlUsd !== null && b.deployedUsd !== null && b.deployedUsd > 0);
    const pnl = marked ? boots.reduce((n, b) => n + (b.pnlUsd as number), 0) : null;
    const deployed = marked ? boots.reduce((n, b) => n + (b.deployedUsd as number), 0) : 0;
    return {
      id: boots[0].compose ?? boots[0].measurement,
      ...(boots[0].compose ? { compose: boots[0].compose } : {}),
      label: strategyLabel(boots[0].label),
      boots,
      trades,
      accounts: [...new Set(boots.flatMap((b) => b.accounts))],
      modelHashes: [...new Set(boots.map((b) => b.modelHash.toLowerCase() as Hex))],
      pnlUsd: pnl,
      returnPct: pnl !== null ? (pnl / deployed) * 100 : null,
      firstTrade: Math.min(...boots.map((b) => b.firstTrade)),
      lastTrade: Math.max(...boots.map((b) => b.lastTrade)),
    };
  });
}

/** Highest return first; an unmarked strategy ranks below every marked one, then by trade count. */
export function rankedStrategies(list: readonly Strategy[]): Strategy[] {
  return [...list].sort((a, b) => (b.returnPct ?? -Infinity) - (a.returnPct ?? -Infinity) || b.trades.length - a.trades.length || b.lastTrade - a.lastTrade);
}

/** A strategy by its compose hash or by the measurement of any of its boots, so a link to one boot opens its strategy. */
export const strategyById = (list: readonly Strategy[], id: string): Strategy | undefined =>
  list.find((s) => s.id.toLowerCase() === id.toLowerCase() || s.boots.some((b) => b.measurement.toLowerCase() === id.toLowerCase()));

/** The boot a follower approves: the one that traded last. */
export const latestBoot = (s: Strategy): TrackAgent => [...s.boots].sort((a, b) => b.lastTrade - a.lastTrade)[0];

export const STRATEGIES: Strategy[] = groupByCompose(TRACK.agents);
