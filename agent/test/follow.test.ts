// Follow, against a local anvil fork of Robinhood Chain testnet (46630) at its current head. The
// account is the live one (0x9c69...), which has several measurements approved at once, so the
// sweep has real work to do. The owner is impersonated by anvil (the fork has no key for it).
//
// Doubles, and only these: the Stylus TDX verifier (a fork cannot run WASM) is replaced with the
// repo's own test verifier (contracts/test/mocks/AgentQuoteVerifier.sol, compiled here), whose
// quote is abi.encode(signer, measurement, nonce) with the same nonce binding, and the ArbSys
// precompile at 0x64 (anvil does not serve arbBlockHash) with the repo's ArbSysDouble. Everything
// the test asserts about approval lives in AgentAccount itself, unchanged and live.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  type Address,
  type Hex,
} from 'viem';
import { agentAccountAbi } from '../src/account-abi.ts';
import { follow, planFollow } from '../src/follow.ts';

const ACCOUNT: Address = '0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D';
const FORK = 'https://rpc.testnet.chain.robinhood.com';
const DEPLOY_BLOCK = 127033401n;
const PORT = 18547;
const URL_ = `http://127.0.0.1:${PORT}`;
// The four measurements the live account has approved at once, and the one chosen to follow.
const FOLLOWED: Hex = '0x993bd67c8e9de5d37d9af6ef41c5c5fdb53b113b8a2b666827e0e619f4978e9a';

const chain = defineChain({ id: 46630, name: 'rhc-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [URL_] } } });
const client = createPublicClient({ chain, transport: http(URL_) });

const anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(PORT), '--auto-impersonate', '--silent'], { stdio: 'ignore' });
after(() => anvil.kill());
for (let i = 0; ; i++) {
  try {
    await client.getChainId();
    break;
  } catch (e) {
    if (i > 60) throw new Error('anvil fork did not come up');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never);
const read = <T,>(functionName: string, args: unknown[] = []) =>
  client.readContract({ address: ACCOUNT, abi: agentAccountAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
const owner = await read<Address>('owner');
const verifierAddr = await read<Address>('verifier');
await rpc('anvil_setBalance', [owner, '0x56bc75e2d63100000']);

const contracts = new URL('../../contracts/', import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), 'mocks-'));
function runtimeOf(name: string): Hex {
  execFileSync('forge', ['build', `test/mocks/${name}.sol`, '--out', join(out, name), '--cache-path', join(out, `${name}-cache`)], { cwd: contracts, env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1' }, stdio: 'ignore' });
  return (JSON.parse(readFileSync(join(out, name, `${name}.sol/${name}.json`), 'utf8')) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
}
await rpc('anvil_setCode', [verifierAddr, runtimeOf('AgentQuoteVerifier')]);
await rpc('anvil_setCode', ['0x0000000000000000000000000000000000000064', runtimeOf('ArbSysDouble')]);

const ownerWallet = createWalletClient({ account: owner, chain, transport: http(URL_) });

async function approvedSet(): Promise<Hex[]> {
  const event = { type: 'event', name: 'MeasurementSet', inputs: [{ name: 'measurement', type: 'bytes32', indexed: true }, { name: 'approved', type: 'bool', indexed: false }] } as const;
  const head = await client.getBlockNumber();
  const logs = [];
  for (let from = DEPLOY_BLOCK; from <= head; from += 4_000_000n) logs.push(...(await client.getLogs({ address: ACCOUNT, event, fromBlock: from, toBlock: from + 3_999_999n < head ? from + 3_999_999n : head })));
  const all = [...new Set(logs.map((l) => l.args.measurement as Hex))];
  const flags = await Promise.all(all.map((m) => read<boolean>('approvedMeasurement', [m])));
  return all.filter((_, i) => flags[i]);
}

async function registerWith(measurement: Hex, signer: Address) {
  const refBlock = (await client.getBlockNumber()) - 1n;
  const nonce = await read<Hex>('attestNonce', [refBlock]);
  const quote = encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [signer, measurement, nonce]);
  const sender = addr(0xdead1);
  await rpc('anvil_setBalance', [sender, '0x56bc75e2d63100000']);
  const w = createWalletClient({ account: sender, chain, transport: http(URL_) });
  const args = { address: ACCOUNT, abi: agentAccountAbi, functionName: 'registerAgent', args: [quote, refBlock], account: sender } as const;
  await client.simulateContract(args);
  const hash = await w.writeContract({ ...args, chain });
  return client.waitForTransactionReceipt({ hash });
}

function revertName(err: unknown): string | undefined {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName;
  }
  return undefined;
}

test('planFollow keeps the followed measurement and withdraws the rest', () => {
  const a = `0x${'aa'.repeat(32)}` as Hex;
  const b = `0x${'bb'.repeat(32)}` as Hex;
  assert.deepEqual(planFollow([a, b], a), { revoke: [b], approve: false });
  assert.deepEqual(planFollow([a, b], b.toUpperCase().replace('0X', '0x') as Hex), { revoke: [a], approve: false });
  assert.deepEqual(planFollow([a], b), { revoke: [a], approve: true });
  assert.deepEqual(planFollow([], b), { revoke: [], approve: true });
});

test('before follow: the live account has several measurements approved at once, so registerAgent admits any of them', async () => {
  const before = await approvedSet();
  assert.ok(before.length >= 3, `expected several approved measurements, saw ${before.length}`);
  const other = before.find((m) => m.toLowerCase() !== FOLLOWED);
  assert.ok(other, 'a second approved measurement exists');
  // Control for the later reverts: this admission succeeds now, so a later revert is the follow's doing.
  const rcpt = await registerWith(other, addr(0xa9e01));
  assert.equal(rcpt.status, 'success');
  assert.equal((await read<Hex>('agentMeasurement')).toLowerCase(), other.toLowerCase());
});

test('follow leaves exactly the followed measurement approved, revokes the old agent, and refuses every other measurement', async () => {
  const before = await approvedSet();
  const r = await follow(client, ownerWallet, ACCOUNT, FOLLOWED, DEPLOY_BLOCK);
  const after = await approvedSet();
  assert.deepEqual(after.map((m) => m.toLowerCase()), [FOLLOWED]);
  assert.equal(r.revoked.length, before.filter((m) => m.toLowerCase() !== FOLLOWED).length);
  assert.ok(r.revoked.length >= 2, 'the sweep withdrew more than one approval');
  assert.equal(await read<Address>('agent'), '0x0000000000000000000000000000000000000000', 'withdrawing the admitted measurement revoked the agent');

  for (const m of before.filter((x) => x.toLowerCase() !== FOLLOWED)) {
    await assert.rejects(registerWith(m, addr(0xa9e02)), (e) => revertName(e) === 'MeasurementNotApproved', m);
  }
  const ok = await registerWith(FOLLOWED, addr(0xa9e03));
  assert.equal(ok.status, 'success');
  assert.equal((await read<Hex>('agentMeasurement')).toLowerCase(), FOLLOWED);
});

test('follow is idempotent and sends nothing when the followed measurement is already the only one', async () => {
  const r = await follow(client, ownerWallet, ACCOUNT, FOLLOWED, DEPLOY_BLOCK);
  assert.deepEqual([r.revoked.length, r.revokeTxs.length, r.approvedTx], [0, 0, undefined]);
});

test('follow refuses a fromBlock that hides the history, a zero measurement, and a non-owner', async () => {
  const head = await client.getBlockNumber();
  const never: Hex = `0x${'0f'.repeat(32)}`;
  await assert.rejects(follow(client, ownerWallet, ACCOUNT, never, head), /wrong account or fromBlock/);
  await assert.rejects(follow(client, ownerWallet, ACCOUNT, `0x${'00'.repeat(32)}`, DEPLOY_BLOCK), /non-zero bytes32/);
  const stranger = addr(0xdead2);
  await rpc('anvil_setBalance', [stranger, '0x56bc75e2d63100000']);
  const sw = createWalletClient({ account: stranger, chain, transport: http(URL_) });
  await assert.rejects(follow(client, sw, ACCOUNT, never, DEPLOY_BLOCK));
  assert.ok((await approvedSet()).every((m) => m.toLowerCase() === FOLLOWED), 'the failed attempts changed no approval');
});
