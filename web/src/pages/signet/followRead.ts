import type { Address, Hex, PublicClient } from 'viem';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { PAXOS_USDG, TSLA } from '../../lib/rhc.generated';
import { poolIdOf, VENUE_POOL } from '../../lib/venue';
import type { FollowState } from './followPlan';

const lim = (r: readonly [boolean, bigint, bigint, bigint]) => ({ allowed: r[0], perTrade: r[1], daily: r[2], approvalAbove: r[3] });

/** What an account says today about following `measurement`, every read pinned to one block. */
export async function readFollowState(c: PublicClient, account: Address, measurement: Hex): Promise<{ state: FollowState; owner: Address; block: bigint }> {
  // The RPC is a pool of nodes: the one that reports the head can be a block ahead of the one that serves the reads.
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAt(c, account, measurement, (await c.getBlock()).number - BigInt(attempt));
    } catch (e) {
      if (attempt >= 4 || !/unsupported block number/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function readAt(c: PublicClient, account: Address, measurement: Hex, block: bigint) {
  const base = { address: account, abi: accountAbi, blockNumber: block } as const;
  const [owner, approved, requestedModelHash, accepted, gatewayMeasurement, poolAllowed, usdg, tsla, agent, agentMeasurement, agentExpiry] = await Promise.all([
    c.readContract({ ...base, functionName: 'owner' }),
    c.readContract({ ...base, functionName: 'approvedMeasurement', args: [measurement] }),
    c.readContract({ ...base, functionName: 'requestedModelHash' }),
    c.multicall({ allowFailure: false, blockNumber: block, contracts: [0n, 1n, 2n, 3n].map((i) => ({ address: account, abi: accountAbi, functionName: 'acceptedServedHashes' as const, args: [i] as const })) }),
    c.readContract({ ...base, functionName: 'gatewayMeasurement' }),
    c.readContract({ ...base, functionName: 'allowedPool', args: [poolIdOf(VENUE_POOL)] }),
    c.readContract({ ...base, functionName: 'limits', args: [PAXOS_USDG] }),
    c.readContract({ ...base, functionName: 'limits', args: [TSLA] }),
    c.readContract({ ...base, functionName: 'agent' }),
    c.readContract({ ...base, functionName: 'agentMeasurement' }),
    c.readContract({ ...base, functionName: 'agentExpiry' }),
  ]);
  return {
    owner, block,
    state: { approved, requestedModelHash, acceptedServedHashes: accepted, gatewayMeasurement, poolAllowed, usdg: lim(usdg), tsla: lim(tsla), agent, agentMeasurement, agentExpiry },
  };
}
