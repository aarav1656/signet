import { describe, expect, it } from 'vitest';
import { matchTrade, type RecordedTrade } from './verify';

const M = `0x${'eb'.repeat(32)}` as const;
const OTHER = `0x${'9d'.repeat(32)}` as const;
const SERVED = `0x${'c8'.repeat(32)}` as const;
const ev = (over: Partial<RecordedTrade> = {}): RecordedTrade => ({ measurement: M, servedModelHash: SERVED, requestHash: `0x${'01'.repeat(32)}`, responseHash: `0x${'02'.repeat(32)}`, ...over });

describe('matchTrade', () => {
  it('passes when the chain recorded this measurement and this model', () => {
    expect(matchTrade([ev()], { measurement: M }, { modelHash: SERVED }).ok).toBe(true);
  });
  it('fails when the chain recorded another measurement', () => {
    const r = matchTrade([ev({ measurement: OTHER })], { measurement: M }, { modelHash: SERVED });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(OTHER);
  });
  it('fails when the chain recorded another model', () => {
    const r = matchTrade([ev({ servedModelHash: OTHER })], { measurement: M }, { modelHash: SERVED });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('model hash');
  });
  it('fails on an empty event list instead of passing vacuously', () => {
    expect(matchTrade([], { measurement: M }, { modelHash: SERVED }).ok).toBe(false);
  });
  it('compares case-insensitively', () => {
    expect(matchTrade([ev({ measurement: M.toUpperCase().replace('0X', '0x') as `0x${string}` })], { measurement: M }, { modelHash: SERVED }).ok).toBe(true);
  });
});
