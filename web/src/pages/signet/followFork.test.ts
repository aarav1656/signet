import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createPublicClient, encodeFunctionData, createTestClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { rhcChain } from '../../chain';
import { DEMO_ACCOUNT } from '../../lib/rhc.generated';
import { latestBoot, STRATEGIES } from '../../lib/track';
import { DEFAULT_LIMITS, REQUESTED_MODEL_HASH, VENUE_GATEWAY_MEASUREMENT } from '../../lib/venue';
import { followCalldata } from './followCalls';
import { parseLimits, pending, planFollow, type FollowSpec } from './followPlan';
import { readFollowState } from './followRead';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const PORT = 8561;
const LOCAL = `http://127.0.0.1:${PORT}`;
const haveAnvil = spawnSync('anvil', ['--version']).status === 0;

// Forks Robinhood Chain testnet with anvil and follows a strategy from the live demo account as its owner (impersonated, nothing sent to the real chain).
describe.skipIf(!haveAnvil)('following on a fork of the live account', () => {
  let anvil: ChildProcess;
  const pub = createPublicClient({ chain: rhcChain, transport: http(LOCAL) });
  const test = createTestClient({ chain: rhcChain, mode: 'anvil', transport: http(LOCAL) });
  const boot = latestBoot(STRATEGIES[0]);
  const other = `0x${'5c'.repeat(32)}` as Hex;
  const usdg = parseLimits(DEFAULT_LIMITS.usdg, 6);
  const tsla = parseLimits(DEFAULT_LIMITS.tsla, 18);
  const spec: FollowSpec = {
    measurement: boot.measurement, requestedModelHash: REQUESTED_MODEL_HASH, servedModelHash: boot.modelHash, gatewayMeasurement: VENUE_GATEWAY_MEASUREMENT,
    usdg: { decimals: 6, limits: DEFAULT_LIMITS.usdg }, tsla: { decimals: 18, limits: DEFAULT_LIMITS.tsla },
  };

  beforeAll(async () => {
    anvil = spawn('anvil', ['--fork-url', RPC, '--port', String(PORT), '--silent'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) {
      try { await pub.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    throw new Error('anvil did not start');
  }, 60_000);
  afterAll(() => { anvil?.kill(); });

  it('an account with a second approved measurement ends with only the followed one approved', async () => {
    if (!usdg.ok || !tsla.ok) throw new Error('default limits must parse');
    const owner = (await pub.readContract({ address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'owner' })) as Address;
    await test.impersonateAccount({ address: owner });
    await test.setBalance({ address: owner, value: 10n ** 20n });
    const wallet = createWalletClient({ account: owner, chain: rhcChain, transport: http(LOCAL) });
    const send = async (data: Hex) => {
      const rc = await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: DEMO_ACCOUNT, data }) });
      expect(rc.status).toBe('success');
    };
    const ctx = { measurement: boot.measurement, servedModelHash: boot.modelHash, usdg: usdg.value, tsla: tsla.value };

    // The owner has approved some other measurement earlier.
    await send(encodeFunctionData({ abi: accountAbi, functionName: 'setMeasurement', args: [other, true] }));
    const before = await readFollowState(pub as never, DEMO_ACCOUNT, boot.measurement);
    expect(before.state.othersApproved, 'the fork must hold a stray approval for the check to mean anything').toContain(other);

    const steps = pending(planFollow(before.state, spec));
    expect(steps.some((s) => s.id === `revoke:${other}`)).toBe(true);
    for (const s of steps) if (s.id !== 'admit') await send(followCalldata(s.id, ctx));

    const after = await readFollowState(pub as never, DEMO_ACCOUNT, boot.measurement);
    expect(after.state.approved).toBe(true);
    expect(after.state.othersApproved).toEqual([]);
    expect(await pub.readContract({ address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'approvedMeasurement', args: [other] })).toBe(false);
  }, 180_000);

  it('must fail: skipping the withdrawal leaves two measurements approved and the read says so', async () => {
    const owner = (await pub.readContract({ address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'owner' })) as Address;
    const wallet = createWalletClient({ account: owner, chain: rhcChain, transport: http(LOCAL) });
    // Approve a stray measurement the way a half-done follow would leave it.
    const approve = (m: Hex) => wallet.writeContract({ address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'setMeasurement', args: [m, true] });
    await pub.waitForTransactionReceipt({ hash: await approve(other) });
    const state = (await readFollowState(pub as never, DEMO_ACCOUNT, boot.measurement)).state;
    expect(state.approved).toBe(true);
    expect(state.othersApproved).toEqual([other]);
    expect(pending(planFollow(state, spec)).map((s) => s.id)).toEqual([`revoke:${other}`, 'admit']);
  }, 120_000);
});
