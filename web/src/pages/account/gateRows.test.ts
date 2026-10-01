import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { buildGateRows, decodeRevertSelector, type AccountLog, type Refusal, type TokenInfo } from './gateRows';
import { agentView } from './agent';
import { ZERO_ADDR } from './read';

const USDG = '0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC' as Address;
const TSLA = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E' as Address;
const AGENT = '0xdd241EC759Ec0BA4A1d08C8bf19FC4a8a6aEA5c7' as Address;
const tokens: TokenInfo[] = [
  { address: USDG, symbol: 'testUSDG', decimals: 6 },
  { address: TSLA, symbol: 'TSLA', decimals: 18 },
];
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const executed = (over: Record<string, unknown>, block: bigint, i: number): AccountLog => ({
  eventName: 'TradeExecuted',
  blockNumber: block,
  logIndex: i,
  transactionHash: h(Number(block)),
  args: { tradeId: 1n, tokenIn: USDG, tokenOut: TSLA, amountIn: 1_000_000n, amountOut: 3_984_027_527_308_004n, servedModelHash: h(9), proposalId: 0n, ...over },
});

// Raw revert selectors as the explorer returns them for the two recorded refusals (deployments/46630.json).
const refusal = (selector: Hex, args: { name: string; value: string }[], block: bigint): Refusal => ({
  hash: h(Number(block)), block, position: 1, time: 1_790_865_161n, from: AGENT, method: 'execute', selector, errorArgs: args, input: '0x',
});

describe('revert decoding', () => {
  it('names the account custom errors by selector', () => {
    expect(decodeRevertSelector('0x0d9ab13f')?.name).toBe('NotAgent');
    expect(decodeRevertSelector('0x4F356490')?.name).toBe('ExceedsPerTradeCap');
    expect(decodeRevertSelector('0xdeadbeef')).toBeUndefined();
  });
});

describe('buildGateRows', () => {
  const logs = [
    executed({}, 100n, 0),
    executed({ tradeId: 2n, proposalId: 1n, amountIn: 2_000_001n }, 300n, 0),
    { eventName: 'TradeProposed', blockNumber: 200n, logIndex: 0, transactionHash: h(200), args: { proposalId: 1n, servedModelHash: h(9), trade: { key: { currency0: USDG, currency1: TSLA }, zeroForOne: true, amountIn: 2_000_001n } } },
    { eventName: 'Transfer', blockNumber: 150n, logIndex: 0, transactionHash: h(150), args: {} },
  ] as AccountLog[];
  const refusals = [
    refusal('0x0d9ab13f', [], 250n),
    refusal('0x4f356490', [{ name: 'amountIn', value: '10000001' }, { name: 'cap', value: '10000000' }], 120n),
  ];
  const rows = buildGateRows(logs, refusals, new Map([[100n, 5n]]), tokens);

  it('merges events and reverts newest first and drops events it does not render', () => {
    expect(rows.map((r) => r.block)).toEqual([300n, 250n, 200n, 120n, 100n]);
  });
  it('shows amount, token and the recorded model hash on a trade row', () => {
    const r = rows.find((x) => x.block === 100n)!;
    expect(r.tag).toBe('EXECUTED');
    expect(r.title).toBe('1.00 testUSDG into 0.003984 TSLA');
    expect(r.sub).toContain('0x0000…0009');
    expect(r.tone).toBe('ok');
  });
  it('marks an owner-approved proposal trade as APPROVED', () => {
    expect(rows.find((x) => x.block === 300n)!.tag).toBe('APPROVED');
  });
  it('gives revert rows the decoded custom error and a red tone', () => {
    const na = rows.find((x) => x.block === 250n)!;
    expect(na.tone).toBe('refuse');
    expect(na.tag).toBe('NotAgent()');
    const cap = rows.find((x) => x.block === 120n)!;
    expect(cap.tag).toBe('ExceedsPerTradeCap()');
    expect(cap.sub).toContain('ExceedsPerTradeCap(amountIn 10000001, cap 10000000)');
  });
  it('is not satisfied by an empty input', () => {
    expect(buildGateRows([], [], new Map(), tokens)).toEqual([]);
  });
});

describe('agentView', () => {
  const expiry = 1_000n;
  it('counts down while the attestation is valid', () => {
    expect(agentView(AGENT, expiry, 400)).toEqual({ state: 'live', left: 600 });
  });
  it('is expired, not an error, once the expiry passes', () => {
    expect(agentView(AGENT, expiry, 1_000)).toEqual({ state: 'expired', ago: 0 });
    expect(agentView(AGENT, expiry, 1_500)).toEqual({ state: 'expired', ago: 500 });
  });
  it('is none when no agent is admitted', () => {
    expect(agentView(ZERO_ADDR, 0n, 5)).toEqual({ state: 'none' });
  });
});
