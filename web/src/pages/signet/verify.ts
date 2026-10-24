import { useQuery } from '@tanstack/react-query';
import { parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { rhcChain } from '../../chain';
import { inWindows } from '../../lib/logs';
import type { TrackAgent, TrackTrade } from '../../lib/track';
import { RHC_DEPLOY_BLOCK } from '../../lib/rhc.generated';
import { agentView, type AgentView } from '../account/agent';
import { recheck, type ReceiptState } from '../account/receiptCheck';

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type RecordedTrade = { measurement: Hex; servedModelHash: Hex; requestHash: Hex; responseHash: Hex };

export type TradeCheck = { tx: Hex; ok: boolean; detail: string; recorded?: RecordedTrade; receipt?: ReceiptState };

/** Does one of the transaction's TradeExecuted events carry this agent's measurement and this trade's model? */
export function matchTrade(events: readonly RecordedTrade[], agent: Pick<TrackAgent, 'measurement'>, trade: Pick<TrackTrade, 'modelHash'>): { ok: boolean; detail: string; recorded?: RecordedTrade } {
  if (events.length === 0) return { ok: false, detail: 'the transaction emitted no TradeExecuted from the account' };
  const hit = events.find((e) => eq(e.measurement, agent.measurement) && eq(e.servedModelHash, trade.modelHash));
  if (hit) return { ok: true, detail: 'the chain recorded this measurement and this model on the trade', recorded: hit };
  const e = events[0];
  return !eq(e.measurement, agent.measurement)
    ? { ok: false, detail: `the chain recorded measurement ${e.measurement}, not ${agent.measurement}`, recorded: e }
    : { ok: false, detail: `the chain recorded model hash ${e.servedModelHash}, not ${trade.modelHash}`, recorded: e };
}

async function pinOf(c: PublicClient, account: Address): Promise<{ requested: Hex; accepted: Hex[] }> {
  const base = { address: account, abi: accountAbi } as const;
  const [requested, accepted] = await Promise.all([
    c.readContract({ ...base, functionName: 'requestedModelHash' }),
    c.multicall({ allowFailure: false, contracts: [0n, 1n, 2n, 3n].map((i) => ({ ...base, functionName: 'acceptedServedHashes' as const, args: [i] as const })) }),
  ]);
  return { requested, accepted: accepted.filter((h) => h !== ZERO32) };
}

/** Read one trade back from the chain: success status, the recorded measurement and model, and the receipt hash recomputed from calldata. */
export async function checkTrade(c: PublicClient, agent: TrackAgent, trade: TrackTrade): Promise<TradeCheck> {
  const rc = await c.getTransactionReceipt({ hash: trade.tx });
  if (rc.status !== 'success') return { tx: trade.tx, ok: false, detail: 'the transaction reverted' };
  const events = parseEventLogs({ abi: accountAbi, eventName: 'TradeExecuted', logs: rc.logs })
    .filter((l) => eq(l.address, trade.account))
    .map((l) => ({ measurement: l.args.agentMeasurement, servedModelHash: l.args.servedModelHash, requestHash: l.args.requestHash, responseHash: l.args.responseHash }));
  const m = matchTrade(events, agent, trade);
  if (!m.ok || !m.recorded) return { tx: trade.tx, ok: false, detail: m.detail, recorded: m.recorded };
  const receipt = await recheck(c, trade.account, { receipt: { requestHash: m.recorded.requestHash, responseHash: m.recorded.responseHash, served: m.recorded.servedModelHash, carrierTx: trade.tx } }, await pinOf(c, trade.account));
  return { tx: trade.tx, ok: true, detail: m.detail, recorded: m.recorded, receipt };
}

export type AgentChecks = { checks: TradeCheck[]; verified: boolean };

/** Every trade of an agent, re-read from the chain. `verified` is true only when the list is non-empty and every check passed. */
export function useAgentChecks(agent: TrackAgent) {
  const client = usePublicClient({ chainId: rhcChain.id });
  return useQuery({
    queryKey: ['signet-checks', agent.measurement, agent.trades.map((t) => t.tx).join()],
    enabled: !!client,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<AgentChecks> => {
      const checks = await Promise.all(agent.trades.map((t) => checkTrade(client as PublicClient, agent, t)));
      return { checks, verified: checks.length > 0 && checks.every((k) => k.ok && k.receipt?.state === 'verified') };
    },
  });
}

export type Admission = { account: Address; agent: Address; approved: boolean; view: AgentView; admittedTx?: Hex; admittedBlock?: bigint; registeredAgent?: Address };

/** What the Stylus Verifier let through under this measurement: the key admitted, the transaction, and whether the account still approves it. */
export function useAdmissions(agent: TrackAgent) {
  const client = usePublicClient({ chainId: rhcChain.id });
  return useQuery({
    queryKey: ['signet-admissions', agent.measurement],
    enabled: !!client,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<{ block: bigint; now: bigint; rows: Admission[] }> => {
      const c = client as PublicClient;
      const head = await c.getBlock();
      const rows = await Promise.all(
        agent.accounts.map(async (account): Promise<Admission> => {
          const base = { address: account, abi: accountAbi } as const;
          const [live, approved, logs] = await Promise.all([
            c.multicall({ allowFailure: false, blockNumber: head.number, contracts: [{ ...base, functionName: 'agent' }, { ...base, functionName: 'agentMeasurement' }, { ...base, functionName: 'agentExpiry' }] }),
            c.readContract({ ...base, functionName: 'approvedMeasurement', args: [agent.measurement], blockNumber: head.number }),
            inWindows(RHC_DEPLOY_BLOCK, head.number, (fromBlock, toBlock) => c.getContractEvents({ ...base, eventName: 'AgentRegistered', fromBlock, toBlock })),
          ]);
          const mine = logs.filter((l) => eq(l.args.measurement as string, agent.measurement));
          const last = mine.at(-1);
          const now = Number(head.timestamp);
          return {
            account, approved, agent: live[0],
            view: eq(live[1], agent.measurement) ? agentView(live[0], live[2], now) : { state: 'none' },
            admittedTx: last?.transactionHash, admittedBlock: last?.blockNumber, registeredAgent: last?.args.agent as Address | undefined,
          };
        }),
      );
      return { block: head.number, now: head.timestamp, rows };
    },
  });
}
