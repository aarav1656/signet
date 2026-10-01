import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromWire, toWire } from '../src/wire.ts';

test('bigints survive the wire, including nested in a Trade and a receipt', () => {
  const v = { functionName: 'execute', gas: 600_000n, args: [{ amountIn: 2_000_001n, key: { fee: 3000 }, zeroForOne: true }, { signature: '0x01' }] };
  assert.deepEqual(fromWire(toWire(v)), v);
});

test('plain objects with other keys named like the marker are left alone', () => {
  const v = { $bigint: 'x', other: 1 };
  assert.deepEqual(fromWire(toWire(v)), v);
});
