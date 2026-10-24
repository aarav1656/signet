import { parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
import { accountAbi, factoryAbi } from '../../abi/AgentAccount.generated';
import { assayAbi } from '../../abi/Assay.generated';
import { DEMO_ACCOUNT, LEGACY_ACCOUNT, PAXOS_USDG, RHC_VERIFIER, TSLA, USDG_ASSAY } from '../../lib/rhc.generated';

/// Every transaction the tour reads. Each hash is also in contracts/deployments/46630.json (tour.test.ts
/// checks that), and every row resolves only when the chain's receipt matches `expect`.
export const TX = {
  admit: '0xec2e5abacab4f45a15176bed75480c6fae0e0b5c94858501f58714729b5f0d3a',
  stolenSigner: '0xf98156ad950c82abe4ce3ab0eac3da0ae860d1abd91fdb9eb545aa87e7e2fcc8',
  create: '0x47076397ffb90ba98bbbb34248c1b3aa91241aa69ba23017ce05b1e62d380e62',
  trade: '0x0023f35941a1490017d220c94b41124f53b044b7416f59ea278208ee500e3b03',
  overCap: '0xb1adb7231fbd38b77489769d7db754b30f36fa9b1ba97bf14f51980f3b12528c',
  approve: '0x7f2a63f44c439d6099133bad32da8f346414f66f2f8541a3fedca496c4d81ead',
  wrongModel: '0x9f2bd92252dce7827bebac226e269f46956e4d5cc368eb3f6dc7e8253eca8bdb',
} as const satisfies Record<string, Hex>;

/// Accounts the operator agent serves, all from the factories in 46630.json.
export const OPERATOR_ACCOUNTS: readonly Address[] = [
  DEMO_ACCOUNT,
  LEGACY_ACCOUNT,
  '0xE1d7939105cF8B3670d6b4a0E15546C036e6c34c',
  '0x06AAadCc83873775D8A72F42B912f57ab3dc2506',
  '0x5492A8e671D37e5785020c02b83cA5603be8D5D7',
];

export type Outcome = 'success' | 'reverted';
export type Receipt = { hash: Hex; status: Outcome; block: bigint; gasUsed: bigint };
/** A row is proven only when what the chain says equals what the row claims. */
export const matches = (r: Receipt | undefined, expect: Outcome) => !!r && r.status === expect;

const erc8056 = (['uiMultiplier', 'newUIMultiplier', 'effectiveAt'] as const).map((name) => ({
  type: 'function', name, inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
} as const));

export type Tour = {
  block: bigint;
  receipts: Record<keyof typeof TX, Receipt>;
  verifierPrefix: string;
  verifierBytes: number;
  agent: Address;
  measurement: Hex;
  expiry: bigint;
  operatorAgents: { account: Address; agent: Address }[];
  created?: Address;
  trade?: { amountIn: bigint; amountOut: bigint; served: Hex; tokenIn: Address };
  approved?: { amountIn: bigint; amountOut: bigint; proposalId: bigint };
  wrongModelPaid: bigint;
  corp: { current: bigint; next: bigint; effectiveAt: bigint; cooldown: bigint };
};

export async function readTour(c: PublicClient, block: bigint): Promise<Tour> {
  const entries = Object.entries(TX) as [keyof typeof TX, Hex][];
  const raw = await Promise.all(entries.map(([, h]) => c.getTransactionReceipt({ hash: h })));
  const receipts = Object.fromEntries(
    entries.map(([k, h], i) => [k, { hash: h, status: raw[i].status, block: raw[i].blockNumber, gasUsed: raw[i].gasUsed }]),
  ) as Tour['receipts'];
  const logsOf = (k: keyof typeof TX) => raw[entries.findIndex(([n]) => n === k)].logs;

  const at = { blockNumber: block, allowFailure: false } as const;
  const [agent, measurement, expiry, cooldown] = await c.multicall({
    ...at,
    contracts: [
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'agent' },
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'agentMeasurement' },
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'agentExpiry' },
      { address: DEMO_ACCOUNT, abi: accountAbi, functionName: 'CORPORATE_ACTION_COOLDOWN' },
    ],
  });
  const agents = await c.multicall({
    ...at,
    contracts: OPERATOR_ACCOUNTS.map((a) => ({ address: a, abi: accountAbi, functionName: 'agent' as const })),
  });
  const [ui, next, effectiveAt] = await c.multicall({
    ...at,
    contracts: erc8056.map((f) => ({ address: TSLA, abi: erc8056, functionName: f.name })),
  });
  const channel = await c.readContract({ address: USDG_ASSAY, abi: assayAbi, functionName: 'channels', args: [0n], blockNumber: block });
  const code = (await c.getCode({ address: RHC_VERIFIER, blockNumber: block })) ?? '0x';

  const created = parseEventLogs({ abi: factoryAbi, logs: logsOf('create'), eventName: 'AccountCreated' })[0]?.args.account;
  const t = parseEventLogs({ abi: accountAbi, logs: logsOf('trade'), eventName: 'TradeExecuted' })[0]?.args;
  const a = parseEventLogs({ abi: accountAbi, logs: logsOf('approve'), eventName: 'TradeExecuted' })[0]?.args;

  return {
    block,
    receipts,
    verifierPrefix: code.slice(0, 10),
    verifierBytes: (code.length - 2) / 2,
    agent,
    measurement,
    expiry,
    operatorAgents: OPERATOR_ACCOUNTS.map((account, i) => ({ account, agent: agents[i] })),
    created,
    trade: t && { amountIn: t.amountIn, amountOut: t.amountOut, served: t.servedModelHash, tokenIn: t.tokenIn },
    approved: a && { amountIn: a.amountIn, amountOut: a.amountOut, proposalId: a.proposalId },
    wrongModelPaid: channel[3],
    corp: { current: ui, next, effectiveAt, cooldown },
  };
}

export const isPaxosUsdg = (a: Address) => a.toLowerCase() === PAXOS_USDG.toLowerCase();
