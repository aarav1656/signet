// Runs src/cvm.ts as a child process against the live RHC testnet account, with a fake dstack
// socket standing in for the guest agent. The fake records report_data, so the test checks the
// bytes the CVM asks the TEE to bind: agent(20) || 0(12) || attestNonce(32), where the nonce is
// what the deployed account returns for the refBlock the CVM reports.
//
// The CVM's RPC is a pass-through proxy that records every method, and answers
// eth_sendRawTransaction itself without forwarding, so a signed transaction is observable at the
// RPC boundary and can never reach the chain from this file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import { agentAccountAbi } from '../src/account-abi.ts';
import { poolKey, TSLA } from '../src/account.ts';
import { fromWire, toWire } from '../src/wire.ts';
import { sha256Hex } from '../src/strategy.ts';

const ACCOUNT = '0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const PORT = 18080;
const TOKEN = 'test-token';
const STRATEGY = readFileSync(new URL('./fixtures/strategy.json', import.meta.url));
const STRATEGY_ENV = { STRATEGY_B64: STRATEGY.toString('base64'), STRATEGY_SHA256: sha256Hex(STRATEGY) };
// Not a credential: the loop never reaches the model in these tests because the generated agent
// key is not registered on the account, so it skips before any inference call.
const CVM_ENV = { PHALA_MODEL: 'phala/qwen3.8-27b-uncensored', PHALA_BASE_URL: 'https://inference.phala.com', PHALA_API_KEY: 'unused-in-tests', ...STRATEGY_ENV };

const rpcMethods: string[] = [];
const proxy = httpServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const calls = JSON.parse(body) as { id: number; method: string } | { id: number; method: string }[];
    for (const c of Array.isArray(calls) ? calls : [calls]) rpcMethods.push(c.method);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!Array.isArray(calls) && calls.method === 'eth_sendRawTransaction') return res.end(JSON.stringify({ jsonrpc: '2.0', id: calls.id, result: `0x${'ab'.repeat(32)}` }));
    res.end(await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text());
  });
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

const seen: string[] = [];
const dir = mkdtempSync(join(tmpdir(), 'dstack-'));
const sock = join(dir, 'dstack.sock');
const fake = httpServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    assert.equal(req.url, '/GetQuote');
    seen.push((JSON.parse(body) as { report_data: string }).report_data);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ quote: 'deadbeef', event_log: '[]' }));
  });
});
await new Promise<void>((r) => fake.listen(sock, r));

const child = spawn('node', ['src/cvm.ts'], {
  env: { ...process.env, ...CVM_ENV, DSTACK_SOCKET: sock, ACCOUNT_ADDRESS: ACCOUNT, RHC_RPC_URL: PROXY, CONTROL_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let childOut = '';
await new Promise<void>((resolve, reject) => {
  child.stdout.on('data', (d: Buffer) => {
    childOut += d;
    if (d.toString().includes('serving account')) resolve();
  });
  child.on('exit', (c) => reject(new Error(`cvm exited ${c}`)));
});
after(() => {
  child.kill();
  fake.close();
  proxy.close();
});
const base = `http://127.0.0.1:${PORT}`;

test('/quote binds the generated agent key and the account attestNonce', async () => {
  const q = fromWire<{ agent: Hex; refBlock: bigint; nonce: Hex; quote: Hex }>(await (await fetch(`${base}/quote`, { method: 'POST' })).text());
  const chain = defineChain({ id: 46630, name: 'rhc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const nonce = await createPublicClient({ chain, transport: http(RPC) }).readContract({ address: ACCOUNT, abi: agentAccountAbi, functionName: 'attestNonce', args: [q.refBlock] });
  assert.equal(q.nonce, nonce);
  assert.equal(q.quote, '0xdeadbeef');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], q.agent.slice(2).toLowerCase() + '0'.repeat(24) + (nonce as string).slice(2));
  assert.equal(seen[0].length, 128);
});

// A signed execute with a valid bearer and an explicit gas limit (which skips estimation, so the
// old route would have signed and broadcast it). Zero eth_sendRawTransaction at the RPC boundary
// and a 404 mean no outside caller can make this key move funds.
test('/tx is gone: a valid bearer and a well-formed execute sign nothing', async () => {
  const trade = { key: poolKey('0xd2b6c1e0a7f4b3c29e8d5a61f0c7b4e3a2918d7c', TSLA), zeroForOne: true, amountIn: 1_000_000n, minOut: 1n, deadline: 1_790_000_600n };
  const receipt = { pubkey: `0x${'00'.repeat(32)}`, receiptBytes: '0x', signature: '0x' };
  const body = toWire({ functionName: 'execute', args: [trade, receipt], gas: 600_000n, account: ACCOUNT });
  const sentBefore = rpcMethods.filter((m) => m === 'eth_sendRawTransaction').length;
  for (const [method, path, headers] of [
    ['POST', '/tx', { authorization: `Bearer ${TOKEN}` }],
    ['POST', '/tx', {}],
    ['GET', '/tx', { authorization: `Bearer ${TOKEN}` }],
    ['POST', '/tx/', { authorization: `Bearer ${TOKEN}` }],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method, headers, ...(method === 'POST' ? { body } : {}) });
    const text = await res.text();
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.ok(!text.includes('hash'), text);
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(rpcMethods.filter((m) => m === 'eth_sendRawTransaction').length - sentBefore, 0);
  assert.ok(rpcMethods.includes('eth_call'), 'the proxy saw the loop and /quote reads, so a zero count is not an unplugged proxy');
});

test('the loop runs and skips while the generated key is not the account agent: no inference, no transaction', async () => {
  for (let i = 0; i < 40 && !childOut.includes('cycle '); i++) await new Promise((r) => setTimeout(r, 250));
  assert.match(childOut, /cycle skip: account agent\(\) is not this key/);
  assert.ok(!childOut.includes('inference '), childOut);
  assert.equal(rpcMethods.filter((m) => m === 'eth_sendRawTransaction').length, 0);
});

// A second client account from the same factory: one CVM key, a quote bound to each account's nonce.
const ACCOUNT2 = '0xe1d7939105cf8b3670d6b4a0e15546c036e6c34c';

test('/quote?account= binds the second account nonce, not the default one', async () => {
  const chain = defineChain({ id: 46630, name: 'rhc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const c = createPublicClient({ chain, transport: http(RPC) });
  const res = await fetch(`${base}/quote?account=${ACCOUNT2}`, { method: 'POST' });
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const q = fromWire<{ agent: Hex; account: Hex; refBlock: bigint; nonce: Hex }>(await res.text());
  const [n2, n1] = await Promise.all([
    c.readContract({ address: ACCOUNT2, abi: agentAccountAbi, functionName: 'attestNonce', args: [q.refBlock] }),
    c.readContract({ address: ACCOUNT, abi: agentAccountAbi, functionName: 'attestNonce', args: [q.refBlock] }),
  ]);
  assert.equal(q.account.toLowerCase(), ACCOUNT2);
  assert.equal(q.nonce, n2);
  assert.notEqual(q.nonce, n1);
  assert.equal(seen.at(-1), q.agent.slice(2).toLowerCase() + '0'.repeat(24) + (n2 as string).slice(2));
});

test('/quote refuses a malformed account; /info answers cross-origin', async () => {
  const bad = await fetch(`${base}/quote?account=0x1234`, { method: 'POST' });
  assert.equal(bad.status, 400);
  const info = await fetch(`${base}/info`);
  assert.equal(info.headers.get('access-control-allow-origin'), '*');
});

// Boot commitment: the sealed strategy must hash to the digest pinned in the compose file.
function boot(extra: Record<string, string>, drop: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env, ...CVM_ENV, DSTACK_SOCKET: sock, ACCOUNT_ADDRESS: ACCOUNT, RHC_RPC_URL: PROXY, PORT: '18081', ...extra };
  for (const k of drop) delete env[k];
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const c = spawn('node', ['src/cvm.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d: Buffer) => (out += d));
    c.stderr.on('data', (d: Buffer) => (err += d));
    const t = setTimeout(() => c.kill(), 8000);
    c.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
    c.stdout.on('data', (d: Buffer) => d.toString().includes('serving account') && c.kill());
  });
}

test('boot refuses a strategy whose hash differs from STRATEGY_SHA256, before it opens a port', async () => {
  const edited = Buffer.from(STRATEGY);
  edited[edited.indexOf('Buy only')] = 'b'.charCodeAt(0);
  const r = await boot({ STRATEGY_B64: edited.toString('base64') });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /STRATEGY_SHA256 mismatch/);
  assert.ok(!r.out.includes('serving account'), r.out);
  assert.ok(!r.err.includes('Buy only') && !r.out.includes('Buy only'), 'the strategy text must not reach the logs');
});

test('boot refuses when the pin or the sealed strategy is missing, and boots with both (control)', async () => {
  const noPin = await boot({}, ['STRATEGY_SHA256']);
  assert.notEqual(noPin.code, 0);
  assert.match(noPin.err, /STRATEGY_SHA256 is not set/);
  const noText = await boot({}, ['STRATEGY_B64']);
  assert.notEqual(noText.code, 0);
  assert.match(noText.err, /STRATEGY_B64 is not set/);
  const ok = await boot({});
  assert.match(ok.out, new RegExp(`strategy sha256 ${STRATEGY_ENV.STRATEGY_SHA256} matches the compose pin`));
  assert.match(ok.out, /serving account/);
});
