import { erc20Abi, type Address, type Hex, type PublicClient } from 'viem';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { GATEWAY_MEASUREMENT, RHC_DEPLOY_BLOCK, TEST_USDG, TSLA } from '../../lib/rhc.generated';

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
export const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** Paxos's testnet USDG on Robinhood Chain, the quote asset of the account's second pool. */
export const PAXOS_USDG = '0x7E955252E15c84f5768B83c41a71F9eba181802F' as Address;

/** The tokens the account's pools pair: testUSDG, Paxos USDG and the TSLA Stock Token. */
/** Paxos USDG and the Stock Token lead; testUSDG is the first venue's test quote token and reads last. */
export const TOKENS = [PAXOS_USDG, TSLA, TEST_USDG] as const;

export type Limits = { allowed: boolean; perTrade: bigint; daily: bigint; approvalAbove: bigint };
/** ERC-8056 corporate-action state, read from the token; absent for tokens without the interface. */
const erc8056Abi = (['uiMultiplier', 'newUIMultiplier', 'effectiveAt'] as const).map((name) => ({
  type: 'function', name, inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
} as const));

export type CorporateAction = { current: bigint; next: bigint; effectiveAt: bigint };
export type TokenRow = { address: Address; symbol: string; note?: string; decimals: number; balance: bigint; limits: Limits; used: bigint; corp?: CorporateAction };

export type TradeStruct = {
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
};

export type ExecutedRow = {
  tradeId: bigint;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  agentMeasurement: Hex;
  servedModelHash: Hex;
  proposalId: bigint;
  tx: Hex;
  block: bigint;
  time: bigint;
};

export const STATUS = ['None', 'Pending', 'Executed', 'Rejected', 'Cancelled'] as const;
export type ProposalRow = {
  id: bigint;
  trade: TradeStruct;
  status: (typeof STATUS)[number];
  expiry: bigint;
  servedModelHash: Hex;
  tx: Hex;
};

export type Snapshot = {
  account: Address;
  owner: Address;
  agent: Address;
  agentMeasurement: Hex;
  agentExpiry: bigint;
  paused: boolean;
  approvalTtl: bigint;
  requestedModelHash: Hex;
  gatewayMeasurement: Hex;
  gatewayApproved: boolean;
  tradeCount: bigint;
  proposalCount: bigint;
  tokens: TokenRow[];
  approved: Hex[];
  trades: ExecutedRow[];
  proposals: ProposalRow[];
};

/** Every read pinned to one block. Event scans start at the deployment block, so they are bounded. */
export async function readAccount(c: PublicClient, account: Address, block: bigint): Promise<Snapshot> {
  const base = { address: account, abi: accountAbi } as const;
  const at = { blockNumber: block, allowFailure: false } as const;

  const [owner, agent, agentMeasurement, agentExpiry, paused, approvalTtl, requestedModelHash, gatewayMeasurement, gatewayApproved, tradeCount, proposalCount] =
    await c.multicall({
      ...at,
      contracts: [
        { ...base, functionName: 'owner' },
        { ...base, functionName: 'agent' },
        { ...base, functionName: 'agentMeasurement' },
        { ...base, functionName: 'agentExpiry' },
        { ...base, functionName: 'paused' },
        { ...base, functionName: 'approvalTtl' },
        { ...base, functionName: 'requestedModelHash' },
        { ...base, functionName: 'gatewayMeasurement' },
        { ...base, functionName: 'approvedMeasurement', args: [GATEWAY_MEASUREMENT] },
        { ...base, functionName: 'tradeCount' },
        { ...base, functionName: 'proposalCount' },
      ],
    });

  const rows: TokenRow[] = await Promise.all(
    TOKENS.map(async (t) => {
      const [symbol, decimals, balance, lim, used] = await c.multicall({
        ...at,
        contracts: [
          { address: t, abi: erc20Abi, functionName: 'symbol' },
          { address: t, abi: erc20Abi, functionName: 'decimals' },
          { address: t, abi: erc20Abi, functionName: 'balanceOf', args: [account] },
          { ...base, functionName: 'limits', args: [t] },
          { ...base, functionName: 'windowUsed', args: [t] },
        ],
      });
      const ca = await c.multicall({
        blockNumber: block,
        contracts: (['uiMultiplier', 'newUIMultiplier', 'effectiveAt'] as const).map((functionName) => ({ address: t, abi: erc8056Abi, functionName })),
      });
      const corp = ca.every((x) => x.status === 'success')
        ? { current: ca[0].result as bigint, next: ca[1].result as bigint, effectiveAt: ca[2].result as bigint }
        : undefined;
      return { address: t, symbol, corp, note: t === TEST_USDG ? 'first venue test token' : undefined, decimals, balance, limits: { allowed: lim[0], perTrade: lim[1], daily: lim[2], approvalAbove: lim[3] }, used };
    }),
  );
  // The first venue's test token shows only on accounts that hold it or allow it.
  const tokens = rows.filter((r) => r.address !== TEST_USDG || r.balance > 0n || r.limits.allowed);

  const range = { fromBlock: RHC_DEPLOY_BLOCK, toBlock: block } as const;
  const [measurementLogs, executedLogs, proposedLogs] = await Promise.all([
    c.getContractEvents({ ...base, eventName: 'MeasurementSet', ...range }),
    c.getContractEvents({ ...base, eventName: 'TradeExecuted', ...range }),
    c.getContractEvents({ ...base, eventName: 'TradeProposed', ...range }),
  ]);

  const seen = [...new Set(measurementLogs.map((l) => l.args.measurement as Hex))];
  const flags = seen.length
    ? await c.multicall({ ...at, contracts: seen.map((m) => ({ ...base, functionName: 'approvedMeasurement' as const, args: [m] as const })) })
    : [];
  const approved = seen.filter((_, i) => flags[i]);

  const lastExecuted = executedLogs.slice(-5).reverse();
  const times = await Promise.all(lastExecuted.map((l) => c.getBlock({ blockNumber: l.blockNumber })));
  const trades: ExecutedRow[] = lastExecuted.map((l, i) => ({
    tradeId: l.args.tradeId as bigint,
    tokenIn: l.args.tokenIn as Address,
    tokenOut: l.args.tokenOut as Address,
    amountIn: l.args.amountIn as bigint,
    amountOut: l.args.amountOut as bigint,
    agentMeasurement: l.args.agentMeasurement as Hex,
    servedModelHash: l.args.servedModelHash as Hex,
    proposalId: l.args.proposalId as bigint,
    tx: l.transactionHash,
    block: l.blockNumber,
    time: times[i].timestamp,
  }));

  const lastProposed = proposedLogs.slice(-5).reverse();
  const states = lastProposed.length
    ? await c.multicall({ ...at, contracts: lastProposed.map((l) => ({ ...base, functionName: 'proposals' as const, args: [l.args.proposalId as bigint] as const })) })
    : [];
  const proposals: ProposalRow[] = lastProposed.map((l, i) => ({
    id: l.args.proposalId as bigint,
    trade: l.args.trade as TradeStruct,
    status: STATUS[states[i][3]] ?? 'None',
    expiry: states[i][2],
    servedModelHash: l.args.servedModelHash as Hex,
    tx: l.transactionHash,
  }));

  return {
    account, owner, agent, agentMeasurement, agentExpiry, paused, approvalTtl, requestedModelHash, gatewayMeasurement,
    gatewayApproved, tradeCount, proposalCount, tokens, approved, trades, proposals,
  };
}
