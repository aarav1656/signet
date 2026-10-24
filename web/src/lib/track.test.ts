import { describe, expect, it } from 'vitest';
import raw from '../../lib/track-record.json';
import { PAXOS_USDG, TSLA } from './rhc.generated';
import { agentByMeasurement, composeOf, decimalAmount, executedPriceUsd, fmtAmount, fmtPct, groupByCompose, latestBoot, parseTrack, ranked, rankedStrategies, STRATEGIES, strategyById, strategyLabel, TRACK } from './track';

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
  it('leaves no trade with an amount the page would print as base units', () => {
    for (const a of TRACK.agents) for (const t of a.trades) expect(Number(t.amountIn) < 1e6 && Number(t.amountOut) < 1e6, t.tx).toBe(true);
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

describe('a record written by another process', () => {
  it('reads ISO times, millisecond times and numeric strings', () => {
    const iso = parseTrack(rec([{ measurement: m('a'), trades: [{ ...trade('b', '12' as unknown as number), time: '2026-10-01T15:11:15.000Z' }] }])).agents[0].trades[0];
    expect(iso.time).toBe(Date.parse('2026-10-01T15:11:15.000Z') / 1000);
    expect(iso.block).toBe(12);
    expect(parseTrack(rec([{ measurement: m('a'), trades: [{ ...trade('b', 1), time: 1_790_867_475_000 }] }])).agents[0].trades[0].time).toBe(1_790_867_475);
  });
  it('scales base-unit amounts by the token decimals and leaves decimal amounts alone', () => {
    expect(decimalAmount('1000000', 'USDG')).toBe('1');
    expect(decimalAmount('3910026278631909', 'TSLA')).toBe('0.003910026278631909');
    expect(decimalAmount('0.0039', 'TSLA')).toBe('0.0039');
    expect(decimalAmount('1', 'USDG')).toBe('1');
    expect(decimalAmount('123456789', 'WETH')).toBe('123456789');
  });
  it('names a token address by its symbol', () => {
    const t = parseTrack(rec([{ measurement: m('a'), trades: [{ ...trade('b', 1), tokenIn: PAXOS_USDG, tokenOut: TSLA, amountIn: '1000000' }] }])).agents[0].trades[0];
    expect([t.tokenIn, t.tokenOut, t.amountIn]).toEqual(['USDG', 'TSLA', '1']);
  });
  it('rejects a time that is neither a number nor a date', () => {
    expect(() => parseTrack(rec([{ measurement: m('a'), trades: [{ ...trade('b', 1), time: 'soon' }] }]))).toThrow(/not a time/);
  });
});

describe('executedPriceUsd', () => {
  it('prices a buy and a sell from their own amounts', () => {
    expect(executedPriceUsd({ tokenIn: 'USDG', tokenOut: 'TSLA', amountIn: '1', amountOut: '0.004' })).toBe(250);
    expect(executedPriceUsd({ tokenIn: 'TSLA', tokenOut: 'USDG', amountIn: '0.004', amountOut: '1' })).toBe(250);
  });
  it('has no price for a zero-sized leg', () => {
    expect(executedPriceUsd({ tokenIn: 'USDG', tokenOut: 'TSLA', amountIn: '1', amountOut: '0' })).toBeNull();
  });
});

describe('strategies group boots by compose hash', () => {
  const C = 'ab'.repeat(32);
  const boot = (c: string, workload: string | null, pnlUsd: number | null, deployedUsd: number | null, block: number) =>
    parseTrack(rec([{ measurement: m(c), workload, label: `Agent, CVM boot ${block}`, trades: [trade(c, block)], pnlUsd, deployedUsd, returnPct: 1 }])).agents[0];
  it('reads the compose hash from the workload string and from nothing else', () => {
    expect(composeOf(`compose ${C}`)).toBe(`0x${C}`);
    expect(composeOf(`image ttl.sh/x@sha256:${C}`)).toBeUndefined();
    expect(composeOf(null)).toBeUndefined();
    expect(composeOf('compose 1234')).toBeUndefined();
  });
  it('two boots of one compose are one strategy whose return is total profit over total deployed', () => {
    const [s] = groupByCompose([boot('1', `compose ${C}`, 3, 10, 5), boot('2', `compose ${C}`, 1, 10, 9)]);
    expect(s.boots).toHaveLength(2);
    expect(s.trades.map((t) => t.block)).toEqual([5, 9]);
    expect(s.returnPct).toBeCloseTo(20, 6);
    expect(latestBoot(s).measurement).toBe(m('2'));
  });
  it('a different compose, or a workload with none, is its own strategy', () => {
    const list = groupByCompose([boot('1', `compose ${C}`, 1, 10, 5), boot('2', `compose ${'cd'.repeat(32)}`, 1, 10, 6), boot('3', null, 1, 10, 7)]);
    expect(list).toHaveLength(3);
    expect(list.find((x) => !x.compose)?.id).toBe(m('3'));
  });
  it('is unmarked when one boot has no profit figure, never a partial sum', () => {
    const [s] = groupByCompose([boot('1', `compose ${C}`, 3, 10, 5), boot('2', `compose ${C}`, null, 10, 9)]);
    expect(s.returnPct).toBeNull();
    expect(rankedStrategies([s, groupByCompose([boot('4', null, 1, 10, 3)])[0]])[0].id).toBe(m('4'));
  });
  it('opens a strategy from its compose hash or from any of its boots', () => {
    const list = groupByCompose([boot('1', `compose ${C}`, 1, 10, 5), boot('2', `compose ${C}`, 1, 10, 9)]);
    expect(strategyById(list, `0x${C}`)).toBeDefined();
    expect(strategyById(list, m('2'))).toBeDefined();
    expect(strategyById(list, m('3'))).toBeUndefined();
  });
  it('drops the boot suffix from a label', () => {
    expect(strategyLabel('Signet reference agent, CVM boot 2')).toBe('Signet reference agent');
    expect(strategyLabel('Operator agent')).toBe('Operator agent');
  });
});

describe('the shipped record, grouped', () => {
  it('folds the reference agent boots into one strategy with every trade and a measurement per boot', () => {
    const ref = STRATEGIES.find((s) => s.boots.length > 1);
    expect(ref, 'a strategy with more than one boot').toBeDefined();
    expect(ref!.trades.length).toBe(ref!.boots.reduce((n, b) => n + b.trades.length, 0));
    expect(new Set(ref!.boots.map((b) => b.measurement)).size).toBe(ref!.boots.length);
    expect(ref!.returnPct).not.toBeNull();
    expect(ref!.trades.some((t) => t.tx === '0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03')).toBe(true);
  });
});
