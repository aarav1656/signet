import { parseUnits, type Address, type Hex } from 'viem';
import type { LimitsInput } from '../../lib/venue';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const MAX_U128 = (1n << 128n) - 1n;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type OnchainLimits = { allowed: boolean; perTrade: bigint; daily: bigint; approvalAbove: bigint };

/** What the follower's account says today, read from the chain. */
export type FollowState = {
  approved: boolean;
  /** Every other measurement this account has approved today. Following leaves none of them. */
  othersApproved: readonly Hex[];
  requestedModelHash: Hex;
  acceptedServedHashes: readonly Hex[];
  gatewayMeasurement: Hex;
  poolAllowed: boolean;
  usdg: OnchainLimits;
  tsla: OnchainLimits;
  agent: Address;
  agentMeasurement: Hex;
  agentExpiry: bigint;
};

/** What following this agent means for an account. */
export type FollowSpec = {
  measurement: Hex;
  requestedModelHash: Hex;
  servedModelHash: Hex;
  gatewayMeasurement: Hex;
  usdg: { decimals: number; limits: LimitsInput };
  tsla: { decimals: number; limits: LimitsInput };
};

export type StepId = 'limits-usdg' | 'limits-tsla' | 'pool' | 'model' | 'measurement' | 'admit' | `revoke:${Hex}`;
export type Step = { id: StepId; title: string; detail: string; done: boolean };

export type ParsedLimits = { allowed: true; perTrade: bigint; daily: bigint; approvalAbove: bigint };

/** The limits the form holds as the integers setLimits takes, or the reason the contract would revert. */
export function parseLimits(l: LimitsInput, decimals: number): { ok: true; value: ParsedLimits } | { ok: false; reason: string } {
  const p = (v: string) => {
    try {
      const n = parseUnits(v.trim(), decimals);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  };
  const [perTrade, daily, approvalAbove] = [p(l.perTrade), p(l.daily), p(l.approvalAbove)];
  if (perTrade === null || daily === null || approvalAbove === null) return { ok: false, reason: 'Enter all three limits as numbers above zero.' };
  if (perTrade > MAX_U128 || daily > MAX_U128 || approvalAbove > MAX_U128) return { ok: false, reason: 'A limit is too large.' };
  if (approvalAbove > perTrade) return { ok: false, reason: 'The approval line cannot be above the per-trade limit; the contract reverts BadLimits().' };
  return { ok: true, value: { allowed: true, perTrade, daily, approvalAbove } };
}

const sameLimits = (on: OnchainLimits, want: ParsedLimits) =>
  on.allowed && on.perTrade === want.perTrade && on.daily === want.daily && on.approvalAbove === want.approvalAbove;

/**
 * The ordered calls that make an account follow one measurement. A step already true on the chain is
 * marked done, so a half-finished follow resumes where it stopped. The order is the contract's: both
 * tokens must be allowed before a pool can be, and admission needs an approved measurement.
 */
export function planFollow(state: FollowState, spec: FollowSpec): Step[] {
  const usdg = parseLimits(spec.usdg.limits, spec.usdg.decimals);
  const tsla = parseLimits(spec.tsla.limits, spec.tsla.decimals);
  const modelOk =
    eq(state.requestedModelHash, spec.requestedModelHash) &&
    state.acceptedServedHashes.some((h) => h !== ZERO32 && eq(h, spec.servedModelHash)) &&
    eq(state.gatewayMeasurement, spec.gatewayMeasurement);
  const admitted = state.agent !== '0x0000000000000000000000000000000000000000' && eq(state.agentMeasurement, spec.measurement);
  // approvedMeasurement is a set. Withdrawals come before the approval, so the account never approves two at once.
  const revokes = state.othersApproved.filter((m) => !eq(m, spec.measurement)).map((m): Step => ({
    id: `revoke:${m}`, title: `Withdraw approval from ${m.slice(0, 10)}…${m.slice(-4)}`, detail: 'Another measurement this account approved earlier. Withdrawing it revokes that code if it is the one running.', done: false,
  }));
  return [
    { id: 'limits-usdg', title: 'Cap what the agent can spend in USDG', detail: 'Per trade, per rolling day, and the size above which a trade waits for you.', done: usdg.ok && sameLimits(state.usdg, usdg.value) },
    { id: 'limits-tsla', title: 'Cap what the agent can sell in TSLA', detail: 'The same three limits on the Stock Token leg.', done: tsla.ok && sameLimits(state.tsla, tsla.value) },
    { id: 'pool', title: 'Allow the TSLA/USDG pool', detail: 'The one hookless 0.3% pool on the Uniswap v4 PoolManager.', done: state.poolAllowed },
    { id: 'model', title: 'Pin the model the receipts must name', detail: 'A trade whose receipt names another model reverts.', done: modelOk },
    ...revokes,
    { id: 'measurement', title: 'Approve this measurement', detail: 'Only a key whose TDX quote carries it can trade this account, and no other measurement stays approved.', done: state.approved },
    { id: 'admit', title: 'Admit the running agent', detail: 'The Stylus Verifier checks a fresh quote from the agent and registers its key.', done: admitted },
  ];
}

/** Steps still to send, in order. Empty means the account already follows. */
export const pending = (steps: readonly Step[]) => steps.filter((s) => !s.done);
