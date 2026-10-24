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
  /** The price feed round a trade was valued at, when the record carries one. */
  oracle?: { roundId: string };
};

export type TrackAgent = {
  measurement: Hex;
  modelHash: Hex;
  label: string;
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

export type TrackRecord = { generatedAt: string; chainId: number; block: number; pricing?: TrackPricing; agents: TrackAgent[]; refusals: TrackRefusal[] };

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
  const agents = (o.agents as Record<string, unknown>[]).map((a): TrackAgent => {
    if (!hex32(a.measurement)) throw new Error('track record: agent measurement is not bytes32');
    const trades = (Array.isArray(a.trades) ? (a.trades as Record<string, unknown>[]) : []).map((t): TrackTrade => {
      if (!hex32(t.tx) || !hex32(t.modelHash) || !isAddress(String(t.account))) throw new Error('track record: a trade has a malformed tx, model hash or account');
      const [tokenIn, tokenOut] = [symbolOf(String(t.tokenIn)), symbolOf(String(t.tokenOut))];
      return {
        tx: t.tx, block: num(t.block, 'trade block'), time: seconds(t.time, 'trade time'), account: t.account as Address,
        tokenIn, tokenOut, amountIn: decimalAmount(t.amountIn, tokenIn), amountOut: decimalAmount(t.amountOut, tokenOut),
        priceUsdAtTrade: numOrNull(t.priceUsdAtTrade, 'trade price'), modelHash: t.modelHash,
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
  return { generatedAt: String(o.generatedAt), chainId: 46630, block: num(o.block, 'block'), ...(pricing ? { pricing } : {}), agents, refusals };
}

/** The file is data from another process: an unreadable one empties the board and says why instead of blanking the app. */
function load(): { track: TrackRecord; error?: string } {
  try {
    return { track: parseTrack(raw) };
  } catch (e) {
    return { track: { generatedAt: '', chainId: 46630, block: 0, agents: [], refusals: [] }, error: e instanceof Error ? e.message : String(e) };
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
