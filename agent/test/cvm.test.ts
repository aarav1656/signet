// Runs src/cvm.ts as a child process against the live RHC testnet account, with a fake dstack
// socket standing in for the guest agent. The fake records report_data, so the test checks the
// bytes the CVM asks the TEE to bind: agent(20) || 0(12) || attestNonce(32), where the nonce is
// what the deployed account returns for the refBlock the CVM reports.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, defineChain, type Hex } from 'viem';
import { agentAccountAbi } from '../src/account-abi.ts';
import { fromWire } from '../src/wire.ts';

const ACCOUNT = '0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D';
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const PORT = 18080;
const TOKEN = 'test-token';

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
  env: { ...process.env, DSTACK_SOCKET: sock, ACCOUNT_ADDRESS: ACCOUNT, RHC_RPC_URL: RPC, CONTROL_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise<void>((resolve, reject) => {
  child.stdout.on('data', (d: Buffer) => d.toString().includes('serving account') && resolve());
  child.on('exit', (c) => reject(new Error(`cvm exited ${c}`)));
});
after(() => {
  child.kill();
  fake.close();
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

test('/tx refuses a missing or wrong bearer and any non-agent function', async () => {
  const body = JSON.stringify({ functionName: 'execute', args: [] });
  assert.equal((await fetch(`${base}/tx`, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(`${base}/tx`, { method: 'POST', body, headers: { authorization: 'Bearer nope' } })).status, 401);
  const owner = await fetch(`${base}/tx`, { method: 'POST', body: JSON.stringify({ functionName: 'withdraw', args: [] }), headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(owner.status, 400);
});
