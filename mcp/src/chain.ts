import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionData,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { agentAccountAbi } from './account-abi.js';
import { checkReceipt, receiptKey, type Check } from './receipt.js';

export const RHC_RPC = 'https://rpc.testnet.chain.robinhood.com';
export const RHC_ID = 46630;
const EXPLORER = process.env.CHIRON_EXPLORER_URL ?? 'https://explorer.testnet.chain.robinhood.com';
const DEPLOY_BLOCK = 127033401n;

export const rhcClient = (rpc = RHC_RPC): PublicClient =>
  createPublicClient({ chain: { id: RHC_ID, name: 'Robinhood Chain Testnet', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }, transport: http(rpc) });

const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const fail = (name: string, detail: string): { verified: false; checks: Check[] } => ({ verified: false, checks: [{ name, ok: false, detail }] });

export async function verifyReceipt(c: PublicClient, txHash: Hex, opts: { expectedServed?: Hex } = {}) {
  let rcpt;
  try {
    rcpt = await c.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    return { txHash, ...fail('tx_found', `no receipt for ${txHash}: ${(e as Error).message.slice(0, 120)}`) };
  }
  const base = { txHash, block: rcpt.blockNumber.toString() };
  if (rcpt.status !== 'success') return { ...base, ...fail('tx_succeeded', 'the transaction reverted, no trade happened') };
  const events = parseEventLogs({ abi: agentAccountAbi, logs: rcpt.logs, eventName: ['TradeExecuted', 'TradeProposed'] });
  const ev = events[0];
  if (!ev) return { ...base, ...fail('trade_event', 'no TradeExecuted or TradeProposed event in this transaction') };
  const account = ev.address as Address;
  const a = ev.args as { servedModelHash: Hex; requestHash: Hex; responseHash: Hex };

  const tx = await c.getTransaction({ hash: txHash });
  let receiptBytes: Hex | undefined;
  try {
    const fn = decodeFunctionData({ abi: agentAccountAbi, data: tx.input });
    if (fn.functionName === 'execute' || fn.functionName === 'propose') receiptBytes = (fn.args as readonly [unknown, { receiptBytes: Hex }])[1].receiptBytes;
  } catch {
    // calldata is not an account call (relayed or approveTrade): event fields only
  }

  // Prefer the state at the trade block; the public RPC keeps no history, so fall back to the latest state.
  const read = async (functionName: 'requestedModelHash' | 'acceptedServedHashes' | 'usedReceipt', args?: readonly unknown[]) => {
    const q = { address: account, abi: agentAccountAbi, functionName, args } as never;
    return (await c.readContract({ ...(q as object), blockNumber: rcpt.blockNumber } as never).catch(() => c.readContract(q))) as never;
  };
  const [requested, ...accepted] = await Promise.all([
    read('requestedModelHash') as Promise<Hex>,
    ...[0n, 1n, 2n, 3n].map((i) => read('acceptedServedHashes', [i]) as Promise<Hex>),
  ]);
  const consumed = (await read('usedReceipt', [receiptKey(a.requestHash, a.responseHash)])) as boolean;
  const res = checkReceipt({
    recorded: { requestHash: a.requestHash, responseHash: a.responseHash, served: a.servedModelHash },
    receiptBytes,
    pin: { requested, accepted: accepted.filter((h) => h !== ZERO32) },
    consumed,
    expectedServed: opts.expectedServed,
  });
  return { ...base, account, event: ev.eventName, ...res };
}

export async function accountState(c: PublicClient, account: Address) {
  const read = (functionName: string, args: readonly unknown[] = []) => c.readContract({ address: account, abi: agentAccountAbi, functionName, args } as never) as Promise<never>;
  const [agent, measurement, expiry, tradeCount, paused] = (await Promise.all([read('agent'), read('agentMeasurement'), read('agentExpiry'), read('tradeCount'), read('paused')])) as [Address, Hex, bigint, bigint, boolean];
  const head = await c.getBlockNumber();
  const logs = (await c.getContractEvents({ address: account, abi: agentAccountAbi, fromBlock: DEPLOY_BLOCK, toBlock: head })) as unknown as { eventName: string; args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[];
  const tokens = [...new Set(logs.filter((l) => l.eventName === 'LimitsSet').map((l) => l.args.token as Address))];
  const caps = await Promise.all(
    tokens.map(async (token) => {
      const [allowed, perTrade, daily, approvalAbove] = (await read('limits', [token])) as unknown as [boolean, bigint, bigint, bigint];
      return { token, allowed, perTrade: perTrade.toString(), daily: daily.toString(), approvalAbove: approvalAbove.toString() };
    }),
  );
  const recentTrades = logs
    .filter((l) => l.eventName === 'TradeExecuted')
    .slice(-5)
    .map((l) => ({ tx: l.transactionHash, block: l.blockNumber.toString(), tradeId: String(l.args.tradeId), tokenIn: l.args.tokenIn, amountIn: String(l.args.amountIn), amountOut: String(l.args.amountOut), servedModelHash: l.args.servedModelHash }));
  return { account, head: head.toString(), agent, measurement, expiry: expiry.toString(), paused, tradeCount: tradeCount.toString(), caps, recentTrades };
}

const GLOSS: Record<string, string> = {
  NotAgent: 'The caller is not the registered, attested agent of this account (never admitted, or revoked).',
  AgentExpired: 'The agent attestation has expired and must be renewed with a fresh quote.',
  IsPaused: 'The owner has paused the account.',
  MeasurementNotApproved: 'The agent measurement is not on the owner approved list.',
  ExceedsPerTradeCap: 'The trade amount is above the per-trade cap for that token.',
  NeedsApproval: 'The trade is above the approval line, so it must go through propose and owner approval.',
  DailyCapExceeded: 'The trade would push 24h spending past the daily cap.',
  ModelMismatch: 'The model that served the inference is not the model the owner pinned.',
  ReceiptInvalid: 'The inference receipt signature or structure failed verification.',
  ReceiptKeyNotRegistered: 'The receipt was signed by a key that is not registered on Assay.',
  GatewayMeasurementMismatch: 'The receipt key belongs to a gateway measurement other than the pinned one.',
  ReceiptKeyExpired: 'The receipt signing key has expired.',
  ReceiptAlreadyUsed: 'This receipt already backed an earlier trade. Receipts are single use.',
  ModelNotSet: 'The owner has not pinned a model yet.',
  InsufficientOutput: 'The pool returned less than the minimum output.',
  DeadlinePassed: 'The trade deadline has passed.',
  TokenNotAllowed: 'The token has no limits configured by the owner.',
  PoolNotAllowed: 'The pool is not on the owner allowlist.',
  ProposalNotPending: 'The proposal is already executed, rejected or cancelled.',
  ProposalExpired: 'The proposal lifetime ran out.',
  TradeMismatch: 'The trade passed to approveTrade differs from the proposed one.',
  CorporateActionPending: 'A Stock Token in the trade has an ERC-8056 multiplier change pending or took one effect within the last day, so the agent stays out; the owner can still approve a proposal.',
  AgentIsOwner: 'The quote names the owner key as the agent. Owner and agent must be different keys.',
  ApprovalNotNeeded: 'The trade is inside the approval line, so the agent executes it directly instead of proposing it.',
  BadLimits: 'The approval threshold is above the per-trade cap.',
  HookedPool: 'The pool has a hook contract. The account trades only hookless pools.',
  NativeCurrency: 'The pool uses native ETH. The account trades ERC-20 pairs only.',
  NoCode: 'An address the account needs has no contract code.',
  NotPoolManager: 'Only the Uniswap v4 PoolManager may call the unlock callback.',
  NotSwapping: 'The unlock callback ran outside a swap the account started.',
  OverSpent: 'The pool took more of the input token than the trade allowed.',
  OwnableInvalidOwner: 'The new owner address is invalid (zero).',
  OwnableUnauthorizedAccount: 'Only the account owner may call this.',
  ProposerNotCurrentAgent: 'The proposal came from an agent that is no longer the registered one.',
  QuoteAlreadyUsed: 'This TDX quote already admitted an agent. Each admission needs a fresh quote.',
  ReentrancyGuardReentrantCall: 'A call tried to re-enter the account during another call.',
  RenounceDisabled: 'The owner cannot renounce ownership; the account always has an owner.',
  SafeERC20FailedOperation: 'A token transfer or approval failed.',
  StaleRefBlock: 'The quote names a block more than 256 blocks old; ask the CVM for a fresh quote.',
  ZeroAmount: 'The trade amount is zero.',
  ZeroMinOut: 'The trade sets no minimum output; the account requires slippage protection.',
};
/** Exported for the test that every custom error in the account ABI has a plain-words line. */
export const REFUSAL_GLOSS = GLOSS;

export async function explainRefusal(c: PublicClient, txHash: Hex) {
  const tx = await c.getTransaction({ hash: txHash });
  const rcpt = await c.getTransactionReceipt({ hash: txHash });
  if (rcpt.status === 'success') return { txHash, reverted: false, explanation: 'This transaction succeeded, there is no refusal to explain.' };
  // The explorer's raw trace holds the revert output the chain produced; the public RPC keeps no history to replay.
  let data: Hex | undefined;
  let source = 'explorer raw-trace output';
  try {
    const r = await fetch(`${EXPLORER}/api/v2/transactions/${txHash}/raw-trace`);
    if (r.ok) {
      const t = (await r.json()) as { output?: string };
      if (t.output && t.output.length >= 10) data = t.output as Hex;
    }
  } catch {
    // fall through to the replay below
  }
  if (!data) {
    source = `eth_call replay at block ${rcpt.blockNumber - 1n}`;
    try {
      await c.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber: rcpt.blockNumber - 1n });
    } catch (e) {
      data = findRevertData(e);
    }
  }
  if (!data) return { txHash, reverted: true, error: 'undetermined', explanation: 'The transaction reverted but neither the explorer trace nor an RPC replay returned revert data.' };
  try {
    const err = decodeErrorResult({ abi: agentAccountAbi, data });
    return { txHash, reverted: true, error: err.errorName, args: (err.args ?? []).map(String), source, explanation: GLOSS[err.errorName] ?? `The account refused with ${err.errorName}.` };
  } catch {
    return { txHash, reverted: true, error: 'unknown', data, source, explanation: `Revert data ${data} matches no error in the AgentAccount ABI.` };
  }
}

function findRevertData(e: unknown): Hex | undefined {
  let cur = e as { data?: unknown; cause?: unknown } | undefined;
  while (cur) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x') && cur.data.length >= 10) return cur.data as Hex;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}
