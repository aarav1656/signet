import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { explainRefusal, rhcClient, verifyReceipt } from '../src/chain.js';

// Real transactions on Robinhood Chain testnet 46630, from docs/e2e/robinhood-testnet-agent-account.md.
const TRADE = '0xe50522661b55c797071b56e43aaf2bc91d37c9745a295ff6a5976883dd4ddfa2';
const OVERCAP = '0xb1adb7231fbd38b77489769d7db754b30f36fa9b1ba97bf14f51980f3b12528c';
const SERVED = '0xc8536dbf086093b9b12c84bc9c4448f0c36c74d9b4a65cda6667d9d99f78df59';
const c = rhcClient(process.env.CHIRON_RPC_URL);

describe('verify_receipt', () => {
  it('verifies the real successful trade, every check listed and passing', async () => {
    const r = await verifyReceipt(c, TRADE, { expectedServed: SERVED });
    console.log(JSON.stringify(r.checks.map((k) => [k.name, k.ok])));
    assert.ok(r.checks.length >= 6);
    assert.ok(r.checks.every((k) => k.ok));
    assert.equal(r.verified, true);
  });

  it('is not verified when one field is tampered (different model hash)', async () => {
    const bad = `0x${'11'.repeat(32)}` as const;
    const r = await verifyReceipt(c, TRADE, { expectedServed: bad });
    assert.equal(r.checks.find((k) => k.name === 'served_model_equals_expected')?.ok, false);
    assert.equal(r.verified, false);
  });

  it('is not verified for a reverted transaction', async () => {
    const r = await verifyReceipt(c, OVERCAP);
    assert.equal(r.verified, false);
  });
});

describe('explain_refusal', () => {
  it('decodes the over-cap revert to ExceedsPerTradeCap', async () => {
    const r = await explainRefusal(c, OVERCAP);
    assert.equal(r.reverted, true);
    assert.equal((r as { error?: string }).error, 'ExceedsPerTradeCap');
  });
});
