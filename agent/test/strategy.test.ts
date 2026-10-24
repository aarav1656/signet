// The strategy commitment: the CVM hashes the sealed strategy bytes at boot and refuses any bytes
// that do not hash to the digest pinned in the compose file. The reference digest is OpenSSL's, an
// implementation independent of node:crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadStrategy, parseDecision, parseStrategy, renderPrompt, sha256Hex } from '../src/strategy.ts';

const FILE = new URL('./fixtures/strategy.json', import.meta.url).pathname;
const bytes = readFileSync(FILE);
const pinned = execFileSync('openssl', ['dgst', '-sha256', '-r', FILE]).toString().split(' ')[0];

test('sha256Hex equals openssl over the same bytes, and loadStrategy accepts the pinned digest', () => {
  assert.equal(sha256Hex(bytes), pinned);
  const { strategy, sha256 } = loadStrategy(bytes, pinned);
  assert.equal(sha256, pinned);
  assert.equal(strategy.parameters.amountIn, 1_000_000n);
  assert.equal(strategy.rules.buyReply, 'BUY');
});

test('one changed byte, or a changed digest, refuses; the error does not leak the strategy text', () => {
  const edited = Buffer.from(bytes);
  edited[edited.indexOf('Buy only')] = 'b'.charCodeAt(0);
  assert.throws(() => loadStrategy(edited, pinned), (e: Error) => {
    assert.match(e.message, /STRATEGY_SHA256 mismatch/);
    assert.ok(!e.message.includes('Buy only'));
    assert.ok(!e.message.includes('TSLA'));
    return true;
  });
  assert.throws(() => loadStrategy(bytes, pinned.replace(/^./, pinned[0] === '0' ? '1' : '0')), /STRATEGY_SHA256 mismatch/);
  assert.throws(() => loadStrategy(bytes, 'not-a-digest'), /64 hex characters/);
  assert.equal(loadStrategy(bytes, pinned.toUpperCase()).sha256, pinned);
});

test('parseStrategy rejects a malformed strategy by field name', () => {
  const good = JSON.parse(bytes.toString());
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  assert.doesNotThrow(() => parseStrategy(enc(good)));
  assert.throws(() => parseStrategy(enc({ ...good, version: 2 })), /version/);
  assert.throws(() => parseStrategy(enc({ ...good, prompt: ' ' })), /prompt/);
  assert.throws(() => parseStrategy(enc({ ...good, parameters: { ...good.parameters, amountIn: '0' } })), /amountIn must be positive/);
  assert.throws(() => parseStrategy(enc({ ...good, parameters: { ...good.parameters, amountIn: 1 } })), /amountIn/);
  assert.throws(() => parseStrategy(enc({ ...good, parameters: { ...good.parameters, intervalSeconds: 1 } })), /intervalSeconds/);
  assert.throws(() => parseStrategy(enc({ ...good, rules: { ...good.rules, buyReply: 'buy now' } })), /buyReply/);
  assert.throws(() => parseStrategy(new TextEncoder().encode('{nope')), /valid UTF-8 JSON/);
});

test('renderPrompt fills every placeholder; parseDecision trades only on the buy word', () => {
  const { strategy } = loadStrategy(bytes, pinned);
  const p = renderPrompt(strategy, { amountIn: 1_000_000n, quoteOut: 3_950n, usdgBalance: 9n, tslaBalance: 7n });
  assert.ok(!/[{}]/.test(p));
  for (const v of ['1000000', '3950', 'holds 9 raw', 'and 7 raw']) assert.ok(p.includes(v), v);
  assert.equal(parseDecision(strategy, 'BUY'), 'buy');
  assert.equal(parseDecision(strategy, '  buy, the pool is cheap'), 'buy');
  assert.equal(parseDecision(strategy, 'HOLD'), 'hold');
  assert.equal(parseDecision(strategy, 'Do not BUY'), 'hold');
  assert.equal(parseDecision(strategy, 'BUYING'), 'hold');
  assert.equal(parseDecision(strategy, ''), 'hold');
  assert.equal(parseDecision(strategy, '...'), 'hold');
});
