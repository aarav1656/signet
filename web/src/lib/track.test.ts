import { describe, expect, it } from 'vitest';
import raw from '../../lib/track-record.json';
import { agentByMeasurement, fmtAmount, fmtPct, parseTrack, ranked, TRACK } from './track';

const m = (c: string) => `0x${c.repeat(64)}`;
const trade = (c: string, block: number) => ({ tx: m(c), block, time: 1_790_000_000 + block, account: '0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D', tokenIn: 'USDG', tokenOut: 'TSLA', amountIn: '1', amountOut: '0.0039', priceUsdAtTrade: 255.7, modelHash: m('c') });
const rec = (agents: unknown[], refusals: unknown[] = []) => ({ generatedAt: 'x', chainId: 46630, block: 1, agents, refusals });

describe('the shipped track record', () => {
  it('has attested agents and every trade names a transaction', () => {
    expect(TRACK.agents.length).toBeGreaterThan(0);
    for (const a of TRACK.agents) {
      expect(a.trades.length).toBeGreaterThan(0);
      for (const t of a.trades) expect(t.tx).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
  it('has the refusal, with the reason the chain decoded', () => {
    expect(TRACK.refusals.some((r) => r.tx === '0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8' && r.reason === 'MeasurementNotApproved')).toBe(true);
  });
});

describe('parseTrack', () => {
  it('accepts the file the generator wrote', () => {
    expect(() => parseTrack(raw)).not.toThrow();
  });
  it('refuses a trade without a transaction hash', () => {
    expect(() => parseTrack(rec([{ measurement: m('a'), trades: [{ ...trade('b', 1), tx: '0x12' }] }]))).toThrow(/malformed/);
  });
  it('refuses the wrong chain', () => {
    expect(() => parseTrack({ ...rec([]), chainId: 1 })).toThrow(/46630/);
  });
  it('sorts trades by block and counts them itself', () => {
    const r = parseTrack(rec([{ measurement: m('a'), trades: [trade('b', 9), trade('c', 3)], returnPct: 1, pnlUsd: 1 }]));
    expect(r.agents[0].trades.map((t) => t.block)).toEqual([3, 9]);
    expect(r.agents[0].firstTrade).toBeLessThan(r.agents[0].lastTrade);
  });
});

describe('ranking and formatting', () => {
  const a = (c: string, returnPct: number | null, n: number) => parseTrack(rec([{ measurement: m(c), trades: Array.from({ length: n }, (_, i) => trade('d', i + 1)), returnPct, pnlUsd: null }])).agents[0];
  it('ranks by return, unmarked last, then by trades', () => {
    expect(ranked([a('1', null, 5), a('2', 1.5, 1), a('3', 3, 1), a('4', 3, 2)]).map((x) => x.measurement[2])).toEqual(['4', '3', '2', '1']);
  });
  it('finds an agent by measurement case-insensitively', () => {
    const list = [a('a', 1, 1)];
    expect(agentByMeasurement(list, m('A'))).toBeDefined();
    expect(agentByMeasurement(list, m('b'))).toBeUndefined();
  });
  it('formats a return with its sign and never prints -0.00%', () => {
    expect(fmtPct(1.6899)).toBe('+1.69%');
    expect(fmtPct(-0.4)).toBe('-0.40%');
    expect(fmtPct(-0.0001)).toBe('0.00%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(null)).toBe('unmarked');
  });
  it('trims long decimals', () => {
    expect(fmtAmount('0.003910026278631909')).toBe('0.00391');
    expect(fmtAmount('1')).toBe('1.00');
    expect(fmtAmount('104.5')).toBe('104.50');
  });
});
