import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, REQUESTED_MODEL_HASH, VENUE_GATEWAY_MEASUREMENT } from '../../lib/venue';
import { parseLimits, pending, planFollow, type FollowSpec, type FollowState, type OnchainLimits } from './followPlan';

const M = `0x${'eb'.repeat(32)}` as const;
const SERVED = '0xc8536dbf086093b9b12c84bc9c4448f0c36c74d9b4a65cda6667d9d99f78df59' as const;
const ZERO = `0x${'0'.repeat(64)}` as const;
const NO_AGENT = '0x0000000000000000000000000000000000000000' as const;
const none: OnchainLimits = { allowed: false, perTrade: 0n, daily: 0n, approvalAbove: 0n };

const spec: FollowSpec = {
  measurement: M, requestedModelHash: REQUESTED_MODEL_HASH, servedModelHash: SERVED, gatewayMeasurement: VENUE_GATEWAY_MEASUREMENT,
  usdg: { decimals: 6, limits: DEFAULT_LIMITS.usdg }, tsla: { decimals: 18, limits: DEFAULT_LIMITS.tsla },
};
const fresh: FollowState = {
  approved: false, requestedModelHash: ZERO, acceptedServedHashes: [ZERO, ZERO, ZERO, ZERO], gatewayMeasurement: ZERO, poolAllowed: false,
  usdg: none, tsla: none, agent: NO_AGENT, agentMeasurement: ZERO, agentExpiry: 0n,
};
const following = (): FollowState => {
  const u = parseLimits(spec.usdg.limits, 6), t = parseLimits(spec.tsla.limits, 18);
  if (!u.ok || !t.ok) throw new Error('defaults must parse');
  return {
    approved: true, requestedModelHash: REQUESTED_MODEL_HASH, acceptedServedHashes: [SERVED, ZERO, ZERO, ZERO], gatewayMeasurement: VENUE_GATEWAY_MEASUREMENT,
    poolAllowed: true, usdg: u.value, tsla: t.value, agent: '0x4a0BCAE7c9F2F1D1B0cF0e6F4a3e2d1c0b9a78eA', agentMeasurement: M, agentExpiry: 1n,
  };
};

describe('planFollow', () => {
  it('a new account needs all six steps, in the contract order', () => {
    expect(planFollow(fresh, spec).map((s) => s.id)).toEqual(['limits-usdg', 'limits-tsla', 'pool', 'model', 'measurement', 'admit']);
    expect(pending(planFollow(fresh, spec))).toHaveLength(6);
  });
  it('an account that already follows has nothing to send', () => {
    expect(pending(planFollow(following(), spec))).toHaveLength(0);
  });
  it('changing one limit reopens exactly that step', () => {
    const s = following();
    const steps = planFollow({ ...s, usdg: { ...s.usdg, perTrade: s.usdg.perTrade + 1n } }, spec);
    expect(pending(steps).map((x) => x.id)).toEqual(['limits-usdg']);
  });
  it('a different approved measurement is not following: the agent step reopens', () => {
    const steps = planFollow({ ...following(), agentMeasurement: `0x${'9d'.repeat(32)}` }, spec);
    expect(pending(steps).map((x) => x.id)).toEqual(['admit']);
  });
  it('a pin on another model reopens the model step', () => {
    const steps = planFollow({ ...following(), acceptedServedHashes: [`0x${'11'.repeat(32)}`, ZERO, ZERO, ZERO] }, spec);
    expect(pending(steps).map((x) => x.id)).toEqual(['model']);
  });
});

describe('parseLimits mirrors the contract', () => {
  it('rejects an approval line above the per-trade cap (BadLimits)', () => {
    const r = parseLimits({ perTrade: '5', daily: '50', approvalAbove: '6' }, 6);
    expect(r.ok).toBe(false);
  });
  it('rejects zero and non-numbers', () => {
    expect(parseLimits({ perTrade: '0', daily: '50', approvalAbove: '1' }, 6).ok).toBe(false);
    expect(parseLimits({ perTrade: 'x', daily: '50', approvalAbove: '1' }, 6).ok).toBe(false);
  });
  it('converts to the token decimals', () => {
    const r = parseLimits({ perTrade: '10', daily: '50', approvalAbove: '5' }, 6);
    expect(r.ok && r.value.perTrade).toBe(10_000_000n);
  });
});
