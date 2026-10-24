import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { modelNameOf, poolIdOf, REQUESTED_MODEL_HASH, SERVED_MODEL_ID, VENUE_POOL } from './venue';

describe('venue constants match what the chain recorded', () => {
  it('derives the pool id the account emitted in PoolSet (tx 0xe392657e..dfcc, 0xFaaA..3b55)', () => {
    expect(poolIdOf(VENUE_POOL)).toBe('0x38f88da1f16ec1ddafcb2be5b3a0ee82ea9944da87a009e9b5e6fbfb94ba384b');
  });
  it('a different tick spacing is a different pool', () => {
    expect(poolIdOf({ ...VENUE_POOL, tickSpacing: 10 })).not.toBe(poolIdOf(VENUE_POOL));
  });
  it('hashes the requested model to the pin ModelSet recorded (tx 0x22a1883e)', () => {
    expect(REQUESTED_MODEL_HASH).toBe('0x245e10b5c3befa4510d11cba0fe4ad1aa3dc9f8def21eb6287a846f8c0b47b9a');
  });
  it('names the served hash recorded in TradeExecuted', () => {
    const served = '0xc8536dbf086093b9b12c84bc9c4448f0c36c74d9b4a65cda6667d9d99f78df59';
    expect(keccak256(toBytes(SERVED_MODEL_ID))).toBe(served);
    expect(modelNameOf(served)).toBe('llama3-3-70b');
    expect(modelNameOf(`0x${'ab'.repeat(32)}`)).toBeUndefined();
  });
});
