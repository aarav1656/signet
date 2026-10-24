import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { accountAbi, factoryAbi } from '../../abi/AgentAccount.generated';
import { rhcChain } from '../../chain';
import { FACTORY, PAXOS_USDG } from '../../lib/rhc.generated';
import { ranked, TRACK } from '../../lib/track';
import { DEFAULT_LIMITS, REQUESTED_MODEL_HASH, VENUE_GATEWAY_MEASUREMENT } from '../../lib/venue';
import { followCalldata } from './followCalls';
import { parseLimits, pending, planFollow, type FollowSpec } from './followPlan';
import { readFollowState } from './followRead';

const KEY = (process.env.SIGNET_E2E === '1' ? process.env.PRIVATE_KEY : undefined) as Hex | undefined;
const RPC = 'https://rpc.testnet.chain.robinhood.com';

// Sends real transactions on Robinhood Chain testnet (46630). Runs only when SIGNET_E2E=1 and PRIVATE_KEY (the account owner) is in the environment:
//   SIGNET_E2E=1 node --env-file=../.env node_modules/vitest/vitest.mjs run src/pages/signet/followE2E.test.ts
describe.skipIf(!KEY)('following an agent on chain', () => {
  const pub = createPublicClient({ chain: rhcChain, transport: http(RPC) });
  const agent = ranked(TRACK.agents)[0];
  const usdg = parseLimits(DEFAULT_LIMITS.usdg, 6);
  const tsla = parseLimits(DEFAULT_LIMITS.tsla, 18);
  const spec: FollowSpec = {
    measurement: agent.measurement, requestedModelHash: REQUESTED_MODEL_HASH, servedModelHash: agent.modelHash, gatewayMeasurement: VENUE_GATEWAY_MEASUREMENT,
    usdg: { decimals: 6, limits: DEFAULT_LIMITS.usdg }, tsla: { decimals: 18, limits: DEFAULT_LIMITS.tsla },
  };

  it('a new account goes from six open steps to only the admission, and the chain agrees', async () => {
    if (!usdg.ok || !tsla.ok) throw new Error('default limits must parse');
    const owner = privateKeyToAccount(KEY as Hex);
    const wallet = createWalletClient({ account: owner, chain: rhcChain, transport: http(RPC) });
    const mined = async (hash: Hex) => {
      const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      expect(rc.status).toBe('success');
      return rc;
    };

    const created = await mined(await wallet.writeContract({ address: FACTORY, abi: factoryAbi, functionName: 'createAccount', args: [owner.address] }));
    const account = parseEventLogs({ abi: factoryAbi, eventName: 'AccountCreated', logs: created.logs })[0]?.args.account as Address;
    expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/);
    console.log('follower account', account, 'createAccount tx', created.transactionHash);

    const before = await readFollowState(pub, account, agent.measurement);
    expect(pending(planFollow(before.state, spec)).map((s) => s.id)).toEqual(['limits-usdg', 'limits-tsla', 'pool', 'model', 'measurement', 'admit']);

    const ctx = { measurement: agent.measurement, servedModelHash: agent.modelHash, usdg: usdg.value, tsla: tsla.value };
    for (const step of pending(planFollow(before.state, spec))) {
      if (step.id === 'admit') continue;
      const rc = await mined(await wallet.sendTransaction({ to: account, data: followCalldata(step.id, ctx) }));
      console.log('step', step.id, rc.transactionHash, 'block', rc.blockNumber);
    }

    const after = await readFollowState(pub, account, agent.measurement);
    expect(pending(planFollow(after.state, spec)).map((s) => s.id)).toEqual(['admit']);
    expect(after.state.approved).toBe(true);
    expect(after.state.poolAllowed).toBe(true);
    expect(after.state.usdg).toEqual({ allowed: true, ...{ perTrade: usdg.value.perTrade, daily: usdg.value.daily, approvalAbove: usdg.value.approvalAbove } });
  }, 600_000);

  it('the account refuses what the form refuses, and refuses a stranger', async () => {
    const owner = privateKeyToAccount(KEY as Hex);
    const stranger = '0x000000000000000000000000000000000000dEaD' as Address;
    const account = (await pub.getContractEvents({ address: FACTORY, abi: factoryAbi, eventName: 'AccountCreated', args: { owner: owner.address }, fromBlock: (await pub.getBlockNumber()) - 90_000n })).at(-1)?.args.account as Address;
    expect(account).toBeDefined();
    await expect(
      pub.simulateContract({ address: account, abi: accountAbi, functionName: 'setLimits', args: [PAXOS_USDG, { allowed: true, perTrade: 1n, daily: 2n, approvalAbove: 2n }], account: owner }),
    ).rejects.toThrow(/BadLimits/);
    expect(parseLimits({ perTrade: '1', daily: '2', approvalAbove: '2' }, 6).ok).toBe(false);
    await expect(
      pub.simulateContract({ address: account, abi: accountAbi, functionName: 'setMeasurement', args: [agent.measurement, true], account: stranger }),
    ).rejects.toThrow(/OwnableUnauthorizedAccount/);
  }, 60_000);
});
