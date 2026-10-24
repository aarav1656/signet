// The measured compose file pins what the CVM must not take from outside: the code (image
// digest), the model, the account and chain, and the strategy digest. The rendered file is read
// back and compared with the variables src/cvm.ts requires and with an OpenSSL digest of the
// strategy file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'agent-cvm/render-compose.sh');
const STRATEGY = join(ROOT, 'agent/test/fixtures/strategy.json');
const IMAGE = `ttl.sh/chiron-agent-test@sha256:${'ab'.repeat(32)}`;
const out = join(mkdtempSync(join(tmpdir(), 'compose-')), 'docker-compose.yml');

execFileSync(SCRIPT, [IMAGE, STRATEGY, out]);
const compose = readFileSync(out, 'utf8');
const envBlock = compose.slice(compose.indexOf('environment:'), compose.indexOf('volumes:'));
const env = new Map([...envBlock.matchAll(/^\s+([A-Z0-9_]+): "(.*)"$/gm)].map((m) => [m[1], m[2]]));

test('the rendered compose pins image digest, model, account, chain and the strategy digest as literals', () => {
  assert.match(compose, new RegExp(`^\\s+image: ${IMAGE}$`, 'm'));
  const want = execFileSync('openssl', ['dgst', '-sha256', '-r', STRATEGY]).toString().split(' ')[0];
  assert.equal(env.get('STRATEGY_SHA256'), want);
  assert.match(env.get('ACCOUNT_ADDRESS') ?? '', /^0x[0-9a-fA-F]{40}$/);
  assert.equal(env.get('RHC_CHAIN_ID'), '46630');
  assert.ok((env.get('PHALA_MODEL') ?? '').length > 0 && !env.get('PHALA_MODEL')!.includes('$'));
  assert.ok(!compose.includes('__'), 'no unfilled field');
  assert.ok(!compose.includes('CONTROL_TOKEN'), 'no control token: the CVM takes no outside command');
});

test('only the strategy text and the inference key are sealed; every other variable is a literal', () => {
  const sealed = [...env].filter(([, v]) => v.includes('$')).map(([k]) => k).sort();
  assert.deepEqual(sealed, ['PHALA_API_KEY', 'STRATEGY_B64']);
});

test('every variable src/cvm.ts requires at boot is set in the compose file', () => {
  const cvm = readFileSync(join(ROOT, 'agent/src/cvm.ts'), 'utf8');
  const needed = [...cvm.matchAll(/need\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]);
  assert.ok(needed.length >= 6, `parsed ${needed.length} need() calls`);
  for (const n of needed) assert.ok(env.has(n), `${n} is required by cvm.ts but absent from the compose file`);
});

test('the render refuses an image pinned by tag, a missing strategy, and writes no file', () => {
  const bad = join(mkdtempSync(join(tmpdir(), 'compose-bad-')), 'out.yml');
  const tag = spawnSync(SCRIPT, ['ttl.sh/chiron-agent:latest', STRATEGY, bad]);
  assert.notEqual(tag.status, 0);
  assert.match(tag.stderr.toString(), /sha256/);
  assert.notEqual(spawnSync(SCRIPT, [IMAGE, join(tmpdir(), 'no-such-strategy.json'), bad]).status, 0);
  assert.throws(() => readFileSync(bad));
});
