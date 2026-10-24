// The decision loop's sequencing, against a scripted chain client and an injected inference. What
// is under test is the loop's own logic: that the strategy's rules gate the model call, that the
// model's answer (not the loop) decides, that a buy submits exactly one `execute` built from the
// strategy parameters, and that every other path submits nothing. The chain and Phala are
// scripted; the receipt path itself is covered by receipt.test.ts and the account's own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { agentAccountAbi } from '../src/account-abi.ts';
import { runCycle, type CycleDeps, type TradeLog } from '../src/loop.ts';
import { poolId, poolKey, TSLA } from '../src/account.ts';
import { loadStrategy, sha256Hex, type Strategy } from '../src/strategy.ts';
import { keccak256, toHex } from 'viem';

const bytes = readFileSync(new URL('./fixtures/strategy.json', import.meta.url));
const strategy: Strategy = loadStrategy(bytes, sha256Hex(bytes)).strategy;

const ACCOUNT: Address = getAddress('0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D');
const AGENT: Address = getAddress('0x71f15e33d967F9b0d573Cb03CfE3e7fdBDFd3461');
const USDG: Address = getAddress('0xd2b6c1e0a7f4b3c29e8d5a61f0c7b4e3a2918d7c');
const MODEL = keccak256(toHex('llama3-3-70b'));
const NOW = 1_790_000_000;
const QUOTE_OUT = 3_950_000_000_000_000n;
const SIM_OUT = 4_000_000_000_000_000n;

type World = { agent?: Address; expiry?: bigint; paused?: boolean; quoteOut?: bigint; revertExecute?: boolean };

function ctx(w: World = {}) {
  const writes: { functionName: string; args: readonly unknown[] }[] = [];
  const executedLog = (hash: Hex) => {
    const topics = encodeEventTopics({ abi: agentAccountAbi, eventName: 'TradeExecuted', args: { tradeId: 7n, poolId: poolId(poolKey(USDG, TSLA)), agent: AGENT } });
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
      [USDG, TSLA, 1_000_000n, SIM_OUT, `0x${'11'.repeat(32)}`, MODEL, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`, 0n],
    );
    return { status: 'success', blockNumber: 5n, transactionHash: hash, logs: [{ address: ACCOUNT, topics, data, blockNumber: 5n, logIndex: 0, transactionIndex: 0, blockHash: `0x${'00'.repeat(32)}`, transactionHash: hash, removed: false }] };
  };
  const publicClient = {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'balanceOf') return address === USDG ? 9_000_000n : 7n;
      const table: Record<string, unknown> = {
        agent: w.agent ?? AGENT,
        agentExpiry: w.expiry ?? BigInt(NOW + 20 * 3600),
        paused: w.paused ?? false,
        usdg: USDG,
        allowedPool: true,
        limits: [true, 100_000_000n, 250_000_000n, 50_000_000n],
        requestedModelHash: MODEL,
        gatewayMeasurement: `0x${'44'.repeat(32)}`,
        assay: getAddress('0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D'),
        acceptedServedHashes: args?.[0] === 0n ? MODEL : `0x${'00'.repeat(32)}`,
      };
      if (!(functionName in table)) throw new Error(`unscripted read ${functionName}`);
      return table[functionName];
    },
    simulateContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'quoteExactInputSingle') return { result: [w.quoteOut ?? QUOTE_OUT, 0n] };
      if (functionName === 'execute') return { result: [1_000_000n, SIM_OUT] };
      throw new Error(`unscripted simulate ${functionName}`);
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => executedLog(hash),
  };
  return {
    writes,
    ctx: {
      account: ACCOUNT,
      publicClient: publicClient as never,
      agent: {
        address: AGENT,
        write: async (c: { functionName: 'execute' | 'propose' | 'cancelProposal'; args: readonly unknown[] }) => {
          writes.push(c);
          return `0x${'ab'.repeat(32)}` as Hex;
        },
      },
    },
  };
}

function deps(answer: string) {
  const calls: string[] = [];
  const d: CycleDeps = {
    now: () => NOW,
    inference: async (_ctx, _pin, prompt) => {
      calls.push(prompt);
      return { receipt: { pubkey: `0x${'55'.repeat(32)}`, receiptBytes: '0x1234', signature: '0x5678' }, served: MODEL, answer };
    },
  };
  return { d, calls };
}

test('a BUY answer submits exactly one execute built from the strategy, with the live quote in the prompt', async () => {
  const c = ctx();
  const { d, calls } = deps('BUY');
  const r = await runCycle(c.ctx, strategy, [], d);
  assert.equal(r.action, 'trade');
  assert.equal(c.writes.length, 1);
  assert.equal(c.writes[0].functionName, 'execute');
  const [t] = c.writes[0].args as [{ amountIn: bigint; minOut: bigint; zeroForOne: boolean }];
  assert.equal(t.amountIn, 1_000_000n);
  assert.equal(t.minOut, (SIM_OUT * (10_000n - 50n)) / 10_000n, 'minOut is the simulated output less the strategy slippageBps (50), not the env default');
  assert.equal(calls.length, 1);
  for (const v of [QUOTE_OUT.toString(), '9000000', '1000000']) assert.ok(calls[0].includes(v), `prompt carries ${v}`);
});

test('HOLD, an unparseable answer and a negation submit nothing', async () => {
  for (const answer of ['HOLD', '', 'Do not BUY', 'BUYING']) {
    const c = ctx();
    const r = await runCycle(c.ctx, strategy, [], deps(answer).d);
    assert.equal(r.action, 'hold', answer);
    assert.equal(c.writes.length, 0, answer);
  }
});

test('rules.minQuoteOut stands aside without asking the model', async () => {
  const c = ctx({ quoteOut: 999n });
  const { d, calls } = deps('BUY');
  const r = await runCycle(c.ctx, strategy, [], d);
  assert.equal(r.action, 'hold');
  assert.equal(calls.length, 0);
  assert.equal(c.writes.length, 0);
});

test('an unregistered, expired or paused agent skips before any inference', async () => {
  const worlds: World[] = [{ agent: getAddress('0x0000000000000000000000000000000000000001') }, { expiry: BigInt(NOW + 30) }, { paused: true }];
  for (const w of worlds) {
    const c = ctx(w);
    const { d, calls } = deps('BUY');
    const r = await runCycle(c.ctx, strategy, [], d);
    assert.equal(r.action, 'skip', JSON.stringify(w, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    assert.equal(calls.length, 0);
    assert.equal(c.writes.length, 0);
  }
});

test('maxTradesPerDay stops the loop and an old trade ages out after 24 h', async () => {
  const c = ctx();
  const log: TradeLog = [];
  assert.equal((await runCycle(c.ctx, strategy, log, deps('BUY').d)).action, 'trade');
  assert.equal((await runCycle(c.ctx, strategy, log, deps('BUY').d)).action, 'trade');
  const third = await runCycle(c.ctx, strategy, log, deps('BUY').d);
  assert.equal(third.action, 'skip');
  assert.equal(c.writes.length, 2);
  const aged: TradeLog = [NOW - 86_401, NOW - 86_402];
  assert.equal((await runCycle(c.ctx, strategy, aged, deps('BUY').d)).action, 'trade');
  assert.equal(aged.length, 1);
});

test('a strategy amountIn above the account approvalAbove is never sent as an agent-direct trade', async () => {
  const c = ctx();
  const big: Strategy = { ...strategy, parameters: { ...strategy.parameters, amountIn: 50_000_001n } };
  const r = await runCycle(c.ctx, big, [], deps('BUY').d);
  assert.equal(r.action, 'skip');
  assert.equal(c.writes.length, 0);
});
