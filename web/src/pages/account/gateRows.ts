import { useQuery } from '@tanstack/react-query';
import {
  decodeFunctionData,
  keccak256,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { usePublicClient } from 'wagmi';
import { rhcChain } from '../../chain';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { fmtToken, fmtWhen, short } from '../../lib/format';
import { DEMO_ACCOUNT, MODEL_ID, RHC_DEPLOY_BLOCK, RHC_EXPLORER_URL, RHC_REFUSAL_TXS } from '../../lib/rhc.generated';

export type GateRow = {
  key: string;
  tone: 'ok' | 'refuse';
  title: string;
  sub: string;
  tag: string;
  tx: Hex;
  block: bigint;
  order: number;
  time?: bigint;
  /** What a trade row's receipt hash is recomputed from: the recorded hashes and the tx whose calldata carries the receipt. */
  receipt?: { requestHash: Hex; responseHash: Hex; served: Hex; carrierTx: Hex };
};

export type TokenInfo = { address: Address; symbol: string; decimals: number };

/** One reverted transaction to the account, as the explorer indexes it. */
export type Refusal = {
  hash: Hex;
  block: bigint;
  position: number;
  time: bigint;
  from: Address;
  method: string;
  selector?: Hex;
  errorArgs: { name: string; value: string }[];
  input: Hex;
};

// A decoded event, loosely typed: getContractEvents returns a union over every event in the ABI.
export type AccountLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};

const KNOWN_MODELS: Record<string, string> = Object.fromEntries(
  [MODEL_ID, 'meta-llama/llama-3.3-70b-instruct', 'llama3-3-70b'].map((m) => [keccak256(toHex(m)).toLowerCase(), m]),
);
export const modelName = (hash: string) => KNOWN_MODELS[hash.toLowerCase()];
const modelLabel = (hash: string) => (modelName(hash) ? `${modelName(hash)} (${short(hash)})` : `hash ${short(hash)}`);

const ERROR_SELECTORS = new Map<string, { name: string; argNames: string[] }>(
  accountAbi
    .filter((x) => x.type === 'error')
    .map((x) => [
      toFunctionSelector(`${x.name}(${x.inputs.map((i) => i.type).join(',')})`).toLowerCase(),
      { name: x.name, argNames: x.inputs.map((i) => i.name) },
    ]),
);

/** The custom error a revert selector names in the account's ABI, or undefined. */
export const decodeRevertSelector = (selector: string) => ERROR_SELECTORS.get(selector.toLowerCase());

const REFUSAL_GLOSS: Record<string, string> = {
  NotAgent: 'Caller is not the registered agent',
  ExceedsPerTradeCap: 'Trade above the per-trade cap',
  DailyCapExceeded: 'Trade above the daily cap',
  NeedsApproval: 'Trade above the approval line, the owner decides',
  MeasurementNotApproved: 'Measurement the owner has not approved',
  ModelMismatch: 'Served model differs from the owner pin',
  ProposalNotPending: 'Proposal already settled',
  ProposalExpired: 'Proposal lifetime ran out',
  AgentExpired: 'Agent attestation expired',
  PoolNotAllowed: 'Pool outside the owner allow list',
  TokenNotAllowed: 'Token the owner has not allowed',
  IsPaused: 'Account paused by the owner',
  ReceiptInvalid: 'Receipt did not verify',
  CorporateActionPending: 'Stock Token corporate action pending, agent stays out',
};

const tokenOf = (tokens: TokenInfo[], a: string) => tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());
const amount = (tokens: TokenInfo[], a: string, v: bigint) => {
  const t = tokenOf(tokens, a);
  return t ? `${fmtToken(v, t.decimals)} ${t.symbol}` : `${v.toString()} of ${short(a)}`;
};

/** Trade summary from execute()/propose() calldata: "1.00 testUSDG into TSLA". Undefined for any other call. */
function tradeFromInput(input: Hex, tokens: TokenInfo[]): string | undefined {
  try {
    const d = decodeFunctionData({ abi: accountAbi, data: input });
    if (d.functionName !== 'execute' && d.functionName !== 'propose' && d.functionName !== 'approveTrade') return undefined;
    const t = (d.functionName === 'approveTrade' ? d.args[1] : d.args[0]) as {
      key: { currency0: Address; currency1: Address };
      zeroForOne: boolean;
      amountIn: bigint;
    };
    const [a, b] = t.zeroForOne ? [t.key.currency0, t.key.currency1] : [t.key.currency1, t.key.currency0];
    return `${amount(tokens, a, t.amountIn)} into ${tokenOf(tokens, b)?.symbol ?? short(b)}`;
  } catch {
    return undefined;
  }
}

export function refusalRow(r: Refusal, tokens: TokenInfo[]): GateRow {
  const err = r.selector ? decodeRevertSelector(r.selector) : undefined;
  const name = err?.name ?? 'reverted';
  const trade = tradeFromInput(r.input, tokens);
  const args = r.errorArgs.map((a) => `${a.name} ${a.value}`).join(', ');
  return {
    key: `ref-${r.hash}`,
    tone: 'refuse',
    title: err ? (REFUSAL_GLOSS[name] ?? `${r.method}() refused`) : `${r.method}() reverted, no reason returned`,
    sub: [`${r.method}() from ${short(r.from)}`, trade, args ? `${name}(${args})` : undefined].filter(Boolean).join(' · '),
    tag: err ? `${name}()` : 'REVERTED',
    tx: r.hash,
    block: r.block,
    order: r.position,
    time: r.time,
  };
}

const TAGS = new Set(['TradeExecuted', 'TradeProposed', 'TradeRejected', 'ProposalCancelled', 'AgentRegistered', 'AgentRevoked', 'MeasurementSet', 'ModelSet']);

/** Account events and reverted calls, merged into one newest-first list. Pure: unit-tested. */
export function buildGateRows(logs: AccountLog[], refusals: Refusal[], times: Map<bigint, bigint>, tokens: TokenInfo[]): GateRow[] {
  const rows: GateRow[] = [];
  for (const l of logs) {
    if (!TAGS.has(l.eventName)) continue;
    const a = l.args as Record<string, any>;
    const base = { key: `${l.transactionHash}-${l.logIndex}`, tx: l.transactionHash, block: l.blockNumber, order: l.logIndex, time: times.get(l.blockNumber), tone: 'ok' as const };
    switch (l.eventName) {
      case 'TradeExecuted': {
        const via = (a.proposalId as bigint) > 0n;
        rows.push({
          ...base,
          title: `${via ? `Proposal ${a.proposalId} approved: ` : ''}${amount(tokens, a.tokenIn, a.amountIn)} into ${amount(tokens, a.tokenOut, a.amountOut)}`,
          sub: `Trade ${a.tradeId} · served model ${modelLabel(a.servedModelHash)} recorded`,
          tag: via ? 'APPROVED' : 'EXECUTED',
          receipt: {
            requestHash: a.requestHash,
            responseHash: a.responseHash,
            served: a.servedModelHash,
            carrierTx: via ? (logs.find((x) => x.eventName === 'TradeProposed' && (x.args as Record<string, unknown>).proposalId === a.proposalId)?.transactionHash ?? l.transactionHash) : l.transactionHash,
          },
        });
        break;
      }
      case 'TradeProposed': {
        const t = a.trade as { key: { currency0: Address; currency1: Address }; zeroForOne: boolean; amountIn: bigint };
        const from = t.zeroForOne ? t.key.currency0 : t.key.currency1;
        rows.push({ ...base, title: `Proposal ${a.proposalId}: ${amount(tokens, from, t.amountIn)} above the approval line`, sub: `Waits for the owner · served model ${modelLabel(a.servedModelHash)}`, tag: 'PROPOSED' });
        break;
      }
      case 'TradeRejected':
        rows.push({ ...base, title: `Proposal ${a.proposalId} rejected by the owner`, sub: 'Closed without a trade', tag: 'REJECTED' });
        break;
      case 'ProposalCancelled':
        rows.push({ ...base, title: `Proposal ${a.proposalId} cancelled`, sub: 'Closed without a trade', tag: 'CANCELLED' });
        break;
      case 'AgentRegistered':
        rows.push({ ...base, title: `Agent ${short(a.agent)} admitted`, sub: `Measurement ${short(a.measurement)} · key expires ${fmtWhen(a.expiry)}`, tag: 'ADMITTED' });
        break;
      case 'AgentRevoked':
        rows.push({ ...base, title: `Agent ${short(a.agent)} revoked`, sub: 'Its measurement is no longer trusted', tag: 'REVOKED' });
        break;
      case 'MeasurementSet':
        rows.push({ ...base, title: `Measurement ${short(a.measurement)} ${a.approved ? 'approved' : 'withdrawn'} by the owner`, sub: a.approved ? 'A quote carrying it can admit an agent' : 'No quote carrying it is admitted', tag: a.approved ? 'TRUSTED' : 'UNTRUSTED' });
        break;
      case 'ModelSet':
        rows.push({ ...base, title: `Model pinned: ${modelName(a.requestedModelHash) ?? short(a.requestedModelHash)}`, sub: `Pin ${short(a.requestedModelHash)}, every trade's served model must match it`, tag: 'PINNED' });
        break;
    }
  }
  for (const r of refusals) rows.push(refusalRow(r, tokens));
  return rows.sort((x, y) => (x.block === y.block ? y.order - x.order : x.block < y.block ? 1 : -1));
}

const API = `${RHC_EXPLORER_URL}/api/v2`;
const getJson = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`explorer ${r.status}`);
  return r.json();
};

type BsTx = {
  hash: Hex;
  status: string;
  block_number: number;
  position: number;
  timestamp: string;
  method: string | null;
  from: { hash: Address };
  raw_input: Hex;
  revert_reason?: { method_id?: string; parameters?: { name: string; value: unknown }[] } | null;
};

/**
 * Reverted calls to the account. A reverted transaction emits no log, so the explorer's index is the
 * only enumeration; each hash is then read in full (revert selector, parameters, calldata).
 * `seeds` are hashes the deployment record names, fetched even if the index misses them.
 */
export async function readRefusals(account: Address, seeds: readonly Hex[]): Promise<Refusal[]> {
  const hashes = new Set<string>(seeds.map((h) => h.toLowerCase()));
  let url: string | undefined = `${API}/addresses/${account}/transactions?filter=to`;
  for (let page = 0; url && page < 5; page++) {
    const j: { items: { hash: Hex; status: string }[]; next_page_params: Record<string, string> | null } = await getJson(url);
    for (const t of j.items) if (t.status === 'error') hashes.add(t.hash.toLowerCase());
    url = j.next_page_params ? `${API}/addresses/${account}/transactions?filter=to&${new URLSearchParams(j.next_page_params)}` : undefined;
  }
  const txs: BsTx[] = await Promise.all([...hashes].map((h) => getJson(`${API}/transactions/${h}`)));
  return txs
    .filter((t) => t.status === 'error')
    .map((t) => ({
      hash: t.hash,
      block: BigInt(t.block_number),
      position: t.position,
      time: BigInt(Math.floor(Date.parse(t.timestamp) / 1000)),
      from: t.from.hash,
      method: t.method ?? 'call',
      selector: t.revert_reason?.method_id ? (`0x${t.revert_reason.method_id.replace(/^0x/, '')}` as Hex) : undefined,
      errorArgs: (t.revert_reason?.parameters ?? []).map((p) => ({ name: p.name, value: String(p.value) })),
      input: t.raw_input,
    }));
}

const blockTimes = new Map<bigint, bigint>();
async function timesFor(c: PublicClient, blocks: bigint[]) {
  await Promise.all(
    blocks.filter((b) => !blockTimes.has(b)).map(async (b) => blockTimes.set(b, (await c.getBlock({ blockNumber: b })).timestamp)),
  );
  return blockTimes;
}

export type GateLogData = { head: bigint; logs: AccountLog[]; times: Map<bigint, bigint>; refusals: Refusal[]; refusalsError?: string };

/** Every account event from the deploy block to the head (bounded getLogs), plus the reverted calls. */
export function useGateLog(account: Address) {
  const client = usePublicClient({ chainId: rhcChain.id });
  return useQuery({
    queryKey: ['gatelog', account],
    enabled: !!client,
    refetchInterval: 15_000,
    retry: 1,
    queryFn: async (): Promise<GateLogData> => {
      const c = client as PublicClient;
      const head = await c.getBlockNumber();
      const logs = (await c.getContractEvents({ address: account, abi: accountAbi, fromBlock: RHC_DEPLOY_BLOCK, toBlock: head })) as unknown as AccountLog[];
      const seeds = account.toLowerCase() === DEMO_ACCOUNT.toLowerCase() ? RHC_REFUSAL_TXS : [];
      const refusalsP = readRefusals(account, seeds).then(
        (refusals) => ({ refusals, refusalsError: undefined as string | undefined }),
        (e: unknown) => ({ refusals: [] as Refusal[], refusalsError: e instanceof Error ? e.message : String(e) }),
      );
      const times = await timesFor(c, [...new Set(logs.map((l) => l.blockNumber))]);
      return { head, logs, times, ...(await refusalsP) };
    },
  });
}
