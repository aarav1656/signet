// The Trade the CLI builds must encode exactly as Solidity's abi.encode(t), because
// approveTrade compares keccak256(abi.encode(t)) with the proposal's tradeHash. The reference is
// `cast abi-encode`, an encoder independent of viem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { keccak256, type Address } from 'viem';
import { encodeTrade, poolId, poolKey, tradeHash, TSLA, type Trade } from '../src/account.ts';

const USDG: Address = '0xd2b6c1e0a7f4b3c29e8d5a61f0c7b4e3a2918d7c'; // any testUSDG deployment address

function cast(args: string[]): string {
  return execFileSync('cast', args, { env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' } }).toString().trim();
}

const key = poolKey(USDG, TSLA);
const trade: Trade = { key, zeroForOne: true, amountIn: 1_000_000n, minOut: 3_950_000_000_000_000n, deadline: 1_790_000_600n };

test('poolKey sorts currencies and is the hookless 0.3% / 60 pool', () => {
  assert.ok(BigInt(key.currency0) < BigInt(key.currency1));
  assert.deepEqual([key.fee, key.tickSpacing, key.hooks], [3000, 60, '0x0000000000000000000000000000000000000000']);
  assert.deepEqual(poolKey(TSLA, USDG), key);
});

test('encodeTrade equals cast abi-encode of the same tuple', () => {
  const k = `(${key.currency0},${key.currency1},${key.fee},${key.tickSpacing},${key.hooks})`;
  const ref = cast([
    'abi-encode',
    'f(((address,address,uint24,int24,address),bool,uint128,uint128,uint64))',
    `(${k},${trade.zeroForOne},${trade.amountIn},${trade.minOut},${trade.deadline})`,
  ]);
  assert.equal(encodeTrade(trade), ref);
  assert.equal(tradeHash(trade), keccak256(ref as `0x${string}`));
});

test('poolId equals keccak256 of cast abi-encode of the key', () => {
  const ref = cast(['abi-encode', 'f((address,address,uint24,int24,address))', `(${key.currency0},${key.currency1},3000,60,${key.hooks})`]);
  assert.equal(poolId(key), keccak256(ref as `0x${string}`));
});

test('any field change changes the trade hash (the owner approves one exact trade)', () => {
  const h = tradeHash(trade);
  assert.notEqual(tradeHash({ ...trade, minOut: trade.minOut - 1n }), h);
  assert.notEqual(tradeHash({ ...trade, zeroForOne: false }), h);
  assert.notEqual(tradeHash({ ...trade, deadline: trade.deadline + 1n }), h);
  assert.notEqual(tradeHash({ ...trade, key: { ...key, fee: 500 } }), h);
});
