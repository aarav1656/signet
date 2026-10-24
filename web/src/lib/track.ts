import { isAddress, isHex, type Address, type Hex } from 'viem';
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

export type TrackRefusal = { tx: Hex; block: number; time: number; account: Address; reason: string; measurement: Hex };

export type TrackRecord = { generatedAt: string; chainId: number; block: number; agents: TrackAgent[]; refusals: TrackRefusal[] };

const hex32 = (x: unknown): x is Hex => typeof x === 'string' && isHex(x, { strict: true }) && x.length === 66;
const num = (x: unknown, what: string): number => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`track record: ${what} is not a number`);
  return x;
};
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
      return {
        tx: t.tx, block: num(t.block, 'trade block'), time: num(t.time, 'trade time'), account: t.account as Address,
        tokenIn: String(t.tokenIn), tokenOut: String(t.tokenOut), amountIn: String(t.amountIn), amountOut: String(t.amountOut),
        priceUsdAtTrade: numOrNull(t.priceUsdAtTrade, 'trade price'), modelHash: t.modelHash,
      };
    });
    trades.sort((x, y) => x.block - y.block);
    const first = trades[0]?.time ?? num(a.firstTrade, 'firstTrade');
    const last = trades.at(-1)?.time ?? num(a.lastTrade, 'lastTrade');
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
    return { tx: r.tx, block: num(r.block, 'refusal block'), time: num(r.time, 'refusal time'), account: r.account as Address, reason: String(r.reason), measurement: r.measurement };
  });
  return { generatedAt: String(o.generatedAt), chainId: 46630, block: num(o.block, 'block'), agents, refusals };
}

export const TRACK: TrackRecord = parseTrack(raw);

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

export const fmtDollars = (v: number | null) => (v === null ? 'unmarked' : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** A decimal string for display: two places from 1 up, up to six below ("0.003910026278631909" is "0.00391"). */
export function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', n >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 6 });
}
