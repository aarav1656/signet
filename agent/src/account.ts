// AgentAccount live-cycle modes on RHC testnet (docs/agent-account-spec.md section 13, steps
// 1 to 4). Each mode asserts a post-condition only completion can produce: a decoded log plus
// the account's own balance deltas, never a transaction hash alone.
//
//   acct-trade    step 2: in-policy band-1 buy with a real Phala receipt
//   acct-overcap  step 3: amountIn = perTrade + 1 reverts ExceedsPerTradeCap (eth_call, then
//                 one real reverted transaction for explorer evidence), balances unchanged
//   acct-approve  step 4: band-2 execute reverts NeedsApproval, propose, owner approveTrade,
//                 second approveTrade reverts ProposalNotPending
//
//   acct-register owner side of admission: ask the CVM for a quote, read the measurement the
//                 Verifier returns, approve it, submit registerAgent
//
// The agent is either remote (CVM_URL: the attested agent inside a Phala CVM, whose key is
// generated in the CVM and never seen here) or local (AGENT_PRIVATE_KEY, development only). The
// owner key never enters the CVM. Keys are read by variable name only and never printed:
// OWNER_PRIVATE_KEY, CVM_CONTROL_TOKEN, AGENT_PRIVATE_KEY.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentAccountAbi } from './account-abi.ts';
import { fromWire, toWire } from './wire.ts';
import { phalaModel } from './config.ts';
import { modelHash } from './digest.ts';
import {
  fetchAttestation,
  fetchReceipt,
  receiptSigningInput,
  requestCompletion,
  resolveReceiptKey,
  sha256Hex,
  verifyReceiptLocally,
} from './phala.ts';

export const RHC_TESTNET_ID = 46630;
export const TSLA: Address = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E';
const FEE = 3000;
const TICK_SPACING = 60;
const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type Trade = { key: PoolKey; zeroForOne: boolean; amountIn: bigint; minOut: bigint; deadline: bigint };
export type TradeReceipt = { pubkey: Hex; receiptBytes: Hex; signature: Hex };

const POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;
const TRADE_ABI = {
  type: 'tuple',
  components: [
    { name: 'key', ...POOL_KEY_ABI },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'minOut', type: 'uint128' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

/// The hookless 0.3% pool the deploy script creates, currencies sorted as v4 requires.
export function poolKey(usdg: Address, stock: Address): PoolKey {
  const [currency0, currency1] = BigInt(usdg) < BigInt(stock) ? [usdg, stock] : [stock, usdg];
  return { currency0, currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks: ZERO_ADDRESS };
}

/// PoolIdLibrary.toId: keccak256(abi.encode(key)).
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([POOL_KEY_ABI], [key]));
}

/// abi.encode(t): what approveTrade hashes to match the proposal.
export function encodeTrade(t: Trade): Hex {
  return encodeAbiParameters([TRADE_ABI], [t]);
}

export function tradeHash(t: Trade): Hex {
  return keccak256(encodeTrade(t));
}

/// The 64 bytes the agent's TDX quote must carry: agent (20) || zero (12) || attestNonce (32),
/// exactly what the Verifier returns as signer and checks against the nonce.
export function agentReportData(agent: Address, nonce: Hex): Hex {
  return concat([agent, pad('0x', { size: 12 }), pad(nonce, { size: 32 })]);
}

const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;
const assayRegistryAbi = [
  {
    type: 'function',
    name: 'receiptSigners',
    inputs: [{ name: 'pubkey', type: 'bytes32' }],
    outputs: [{ name: 'measurement', type: 'bytes32' }, { name: 'expiry', type: 'uint64' }],
    stateMutability: 'view',
  },
] as const;

function env(name: string, fallback?: string): string {
  const v = (process.env[name] ?? '').trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set.`);
}

function key(name: string): Hex {
  const k = env(name);
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}

type AgentCall = { functionName: 'execute' | 'propose' | 'cancelProposal'; args: readonly unknown[]; gas?: bigint };

/// The agent, remote or local: an address to simulate as, and a way to send one agent-side call.
async function agentSigner(
  publicClient: PublicClient,
  chain: Chain,
  rpc: string,
  account: Address,
): Promise<{ address: Address; write: (c: AgentCall) => Promise<Hex> }> {
  const cvm = (process.env.CVM_URL ?? '').trim().replace(/\/$/, '');
  if (cvm) {
    const info = fromWire<{ agent: Address; account: Address; chainId: number }>(await (await fetch(`${cvm}/info`)).text());
    if (info.chainId !== RHC_TESTNET_ID) throw new Error(`CVM is on chain ${info.chainId}, expected ${RHC_TESTNET_ID}.`);
    return {
      address: info.agent,
      write: async (c) => {
        const res = await fetch(`${cvm}/tx`, { method: 'POST', headers: { authorization: `Bearer ${env('CVM_CONTROL_TOKEN')}` }, body: toWire({ ...c, account }) });
        const out = fromWire<{ hash?: Hex; error?: string }>(await res.text());
        if (!res.ok || !out.hash) throw new Error(`CVM /tx ${c.functionName}: ${out.error ?? res.status}`);
        return out.hash;
      },
    };
  }
  const local = privateKeyToAccount(key('AGENT_PRIVATE_KEY'));
  const wallet = createWalletClient({ account: local, chain, transport: http(rpc) });
  return {
    address: local.address,
    write: (c) => wallet.writeContract({ address: account, abi: agentAccountAbi, functionName: c.functionName, args: c.args as never, ...(c.gas ? { gas: c.gas } : {}) } as never),
  };
}

async function setup() {
  const rpc = env('RHC_RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
  const chain = defineChain({
    id: RHC_TESTNET_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = env('ACCOUNT_ADDRESS') as Address;
  const owner = privateKeyToAccount(key('OWNER_PRIVATE_KEY'));
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const agent = await agentSigner(publicClient, chain, rpc, account);
  if (agent.address.toLowerCase() === owner.address.toLowerCase()) throw new Error('Refusing: the agent key and the owner key are the same key.');
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc) });
  return { chain, account, agent, owner, publicClient, ownerWallet };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/// A read of the account. With `at`, the read is pinned to that block and retried while the RPC
/// backend that answers has not caught up to it: a read at "latest" straight after a receipt can
/// be served by a node one block behind and return the state from before the transaction.
async function read<T>(ctx: Ctx, functionName: string, args: readonly unknown[] = [], at?: bigint): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await ctx.publicClient.readContract({
        address: ctx.account,
        abi: agentAccountAbi,
        functionName: functionName as never,
        args: args as never,
        ...(at === undefined ? {} : { blockNumber: at }),
      })) as T;
    } catch (e) {
      if (at === undefined || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/// Step 1's post-condition, run before every mode: the chain is RHC testnet, the configured
/// agent key is the account's current agent, and its registration has more than 20 h left.
async function requireFreshAgent(ctx: Ctx) {
  const id = await ctx.publicClient.getChainId();
  if (id !== RHC_TESTNET_ID) throw new Error(`RPC chain id ${id}, expected ${RHC_TESTNET_ID}`);
  const [agent, expiry, owner, paused] = await Promise.all([
    read<Address>(ctx, 'agent'),
    read<bigint>(ctx, 'agentExpiry'),
    read<Address>(ctx, 'owner'),
    read<boolean>(ctx, 'paused'),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (agent.toLowerCase() !== ctx.agent.address.toLowerCase()) {
    throw new Error(`account agent() is ${agent}, not the configured agent key ${ctx.agent.address}; register first.`);
  }
  if (expiry - now <= 20n * 3600n) throw new Error(`agent registration expires in ${expiry - now}s (<= 20 h); refresh it first.`);
  if (owner.toLowerCase() !== ctx.owner.address.toLowerCase()) throw new Error(`account owner() is ${owner}, not the configured owner key.`);
  if (paused) throw new Error('account is paused.');
  console.log(`step 1 ok: agent ${agent} registered, ${(expiry - now) / 3600n} h left`);
}

type Pin = { requested: Hex; accepted: Hex[]; gateway: Hex; assay: Address };

async function readPin(ctx: Ctx): Promise<Pin> {
  const [requested, gateway, assay, ...accepted] = await Promise.all([
    read<Hex>(ctx, 'requestedModelHash'),
    read<Hex>(ctx, 'gatewayMeasurement'),
    read<Address>(ctx, 'assay'),
    ...[0n, 1n, 2n, 3n].map((i) => read<Hex>(ctx, 'acceptedServedHashes', [i])),
  ]);
  return { requested, gateway, assay, accepted };
}

/// One real inference through Phala, verified locally the way ReceiptVerifier and the account
/// will verify it onchain, and refused before any transaction if it would not pass.
async function inferenceReceipt(ctx: Ctx, pin: Pin, prompt: string): Promise<{ receipt: TradeReceipt; served: Hex }> {
  if (modelHash(phalaModel) !== pin.requested) {
    throw new Error(`PHALA_MODEL "${phalaModel}" does not hash to the account's requestedModelHash ${pin.requested}.`);
  }
  const completion = await requestCompletion(prompt, randomUUID());
  const doc = await fetchReceipt(completion.receiptId);
  const attestation = await fetchAttestation(randomBytes(32).toString('hex'));
  if (doc.workload_keyset_digest !== attestation.workloadKeysetDigest) {
    throw new Error('receipt keyset digest does not match the currently attested keyset.');
  }
  const signingKey = resolveReceiptKey(attestation, doc.key_id);
  const local = verifyReceiptLocally(doc, signingKey.publicKeyHex);
  if (!local.ok || !local.servedModel) throw new Error(`receipt does not verify locally: ${local.reason}`);
  const requestReceived = doc.event_log.find((e) => e.type === 'request.received');
  if (requestReceived?.body_hash !== `sha256:${sha256Hex(completion.requestBody)}` || local.responseHashHex !== sha256Hex(completion.responseBody)) {
    throw new Error('receipt body hashes do not match the bytes this call sent and received.');
  }
  const served = modelHash(local.servedModel);
  if (modelHash(local.requestedModel) !== pin.requested) throw new Error(`receipt requested "${local.requestedModel}", not the pinned model.`);
  if (!pin.accepted.includes(served)) throw new Error(`receipt served "${local.servedModel}", which is not in the account's accepted set.`);
  const pubkey = (signingKey.publicKeyHex.startsWith('0x') ? signingKey.publicKeyHex : `0x${signingKey.publicKeyHex}`) as Hex;
  const [m, expiry] = await ctx.publicClient.readContract({ address: pin.assay, abi: assayRegistryAbi, functionName: 'receiptSigners', args: [pubkey] });
  if (m !== pin.gateway) throw new Error(`receipt key ${pubkey} is registered under ${m}, not the pinned gateway measurement; run register on RHC.`);
  if (BigInt(Math.floor(Date.now() / 1000)) > expiry) throw new Error(`receipt key ${pubkey} registration expired.`);
  const answer = (JSON.parse(new TextDecoder().decode(completion.responseBody)) as { choices?: { message?: { content?: string } }[] })
    .choices?.[0]?.message?.content;
  console.log(`inference ${completion.receiptId}: served "${local.servedModel}", answer ${JSON.stringify(answer ?? '')}`);
  const receipt: TradeReceipt = {
    pubkey,
    receiptBytes: `0x${Buffer.from(receiptSigningInput(doc)).toString('hex')}` as Hex,
    signature: (doc.signature.startsWith('0x') ? doc.signature : `0x${doc.signature}`) as Hex,
  };
  return { receipt, served };
}

/// Token balances of the account. With `at`, pinned to that block and retried until the RPC backend
/// has it, so a read straight after a receipt cannot return the pre-transaction balance.
async function balances(ctx: Ctx, usdg: Address, at?: bigint) {
  for (let attempt = 0; ; attempt++) {
    try {
      const [u, s] = await Promise.all(
        [usdg, TSLA].map((t) =>
          ctx.publicClient.readContract({
            address: t,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [ctx.account],
            ...(at === undefined ? {} : { blockNumber: at }),
          }),
        ),
      );
      return { usdg: u, tsla: s };
    } catch (e) {
      if (at === undefined || attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function revertName(err: unknown): { name?: string; args?: readonly unknown[] } {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return { name: r.data?.errorName, args: r.data?.args };
  }
  return {};
}

async function expectRevert(p: Promise<unknown>, name: string): Promise<readonly unknown[]> {
  try {
    await p;
  } catch (err) {
    const got = revertName(err);
    if (got.name !== name) throw new Error(`expected revert ${name}, got ${got.name ?? String(err)}`);
    return got.args ?? [];
  }
  throw new Error(`expected revert ${name}, but the call succeeded`);
}

/// The quote asset the agent trades against TSLA: the account's own `usdg()` unless QUOTE_TOKEN
/// names another allowlisted token (the account trades any token the owner has given limits and
/// a pool).
async function market(ctx: Ctx) {
  const usdg = (env('QUOTE_TOKEN', '') || (await read<Address>(ctx, 'usdg'))) as Address;
  const key = poolKey(usdg, TSLA);
  if (!(await read<boolean>(ctx, 'allowedPool', [poolId(key)]))) throw new Error(`pool ${poolId(key)} is not allowlisted on the account.`);
  const [, perTrade, daily, approvalAbove] = await read<[boolean, bigint, bigint, bigint]>(ctx, 'limits', [usdg]);
  const buy = (amountIn: bigint, minOut = 1n): Trade => ({
    key,
    zeroForOne: key.currency0.toLowerCase() === usdg.toLowerCase(),
    amountIn,
    minOut,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  });
  return { usdg, key, perTrade, daily, approvalAbove, buy };
}

/// minOut from the account's own swap simulated at this block, less SLIPPAGE_BPS.
async function quoteMinOut(ctx: Ctx, t: Trade, r: TradeReceipt): Promise<bigint> {
  const { result } = await ctx.publicClient.simulateContract({
    address: ctx.account,
    abi: agentAccountAbi,
    functionName: 'execute',
    args: [{ ...t, minOut: 1n }, r],
    account: ctx.agent.address,
  });
  const out = (result as readonly [bigint, bigint])[1];
  const bps = BigInt(env('SLIPPAGE_BPS', '100'));
  const minOut = (out * (10_000n - bps)) / 10_000n;
  if (minOut === 0n) throw new Error(`simulated output ${out} is too small for a nonzero minOut.`);
  return minOut;
}

const V4_QUOTER: Address = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
const quoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', ...POOL_KEY_ABI },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

async function quoterMinOut(ctx: Ctx, t: Trade): Promise<bigint> {
  const { result } = await ctx.publicClient.simulateContract({
    address: V4_QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: t.key, zeroForOne: t.zeroForOne, exactAmount: t.amountIn, hookData: '0x' }],
  });
  const bps = BigInt(env('SLIPPAGE_BPS', '100'));
  const minOut = (result[0] * (10_000n - bps)) / 10_000n;
  if (minOut === 0n) throw new Error(`quoted output ${result[0]} is too small for a nonzero minOut.`);
  return minOut;
}

type Executed = { tradeId: bigint; amountIn: bigint; amountOut: bigint; servedModelHash: Hex; proposalId: bigint; agentMeasurement: Hex };

async function executedLog(ctx: Ctx, hash: Hex): Promise<{ log: Executed; block: bigint }> {
  const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`tx ${hash} reverted`);
  const logs = parseEventLogs({ abi: agentAccountAbi, logs: rcpt.logs, eventName: 'TradeExecuted' });
  const mine = logs.filter((l) => l.address.toLowerCase() === ctx.account.toLowerCase());
  if (mine.length !== 1) throw new Error(`tx ${hash} emitted ${mine.length} TradeExecuted logs from the account`);
  return { log: mine[0].args as unknown as Executed, block: rcpt.blockNumber };
}

/// TSLA delta == amountOut >= minOut, quote-token delta == -amountIn, served hash == receipt's.
function assertBuyDeltas(
  before: { usdg: bigint; tsla: bigint },
  after: { usdg: bigint; tsla: bigint },
  t: Trade,
  log: Executed,
  served: Hex,
) {
  const got = after.tsla - before.tsla;
  const spent = before.usdg - after.usdg;
  if (got !== log.amountOut || got < t.minOut) throw new Error(`TSLA delta ${got} != logged amountOut ${log.amountOut} or < minOut ${t.minOut}`);
  if (spent !== log.amountIn || spent > t.amountIn) throw new Error(`quote-token delta -${spent} does not match amountIn ${t.amountIn}`);
  if (log.servedModelHash !== served) throw new Error(`event servedModelHash ${log.servedModelHash} != receipt's ${served}`);
}

export async function runAcctTrade(): Promise<void> {
  const ctx = await setup();
  await requireFreshAgent(ctx);
  const m = await market(ctx);
  const pin = await readPin(ctx);
  const amountIn = BigInt(env('TRADE_AMOUNT_IN', '1000000'));
  if (amountIn > m.approvalAbove) throw new Error(`TRADE_AMOUNT_IN ${amountIn} is above approvalAbove ${m.approvalAbove}: not band 1.`);
  const { receipt, served } = await inferenceReceipt(
    ctx,
    pin,
    `An account may buy TSLA with ${amountIn} raw USDG now. Reply BUY or HOLD.`,
  );
  const draft = m.buy(amountIn);
  const t = { ...draft, minOut: await quoteMinOut(ctx, draft, receipt) };
  const before = await balances(ctx, m.usdg);
  const hash = await ctx.agent.write({ functionName: 'execute', args: [t, receipt] });
  const { log, block } = await executedLog(ctx, hash);
  const after = await balances(ctx, m.usdg, block);
  assertBuyDeltas(before, after, t, log, served);
  if (log.proposalId !== 0n) throw new Error('agent-direct trade logged a proposalId');
  if (!pin.accepted.includes(log.servedModelHash)) throw new Error('servedModelHash is not a pinned hash');
  console.log(
    `step 2 ok: tx ${hash} block ${block} tradeId ${log.tradeId}: spent ${log.amountIn} raw quote token, got ${log.amountOut} TSLA (minOut ${t.minOut}); ` +
      `agentMeasurement ${log.agentMeasurement} servedModelHash ${log.servedModelHash}`,
  );
}

export async function runAcctOvercap(): Promise<void> {
  const ctx = await setup();
  await requireFreshAgent(ctx);
  const m = await market(ctx);
  const pin = await readPin(ctx);
  const { receipt } = await inferenceReceipt(ctx, pin, `An account may buy TSLA with ${m.perTrade + 1n} raw USDG. Reply BUY or HOLD.`);
  const t = m.buy(m.perTrade + 1n);
  const before = await balances(ctx, m.usdg);
  const args = await expectRevert(
    ctx.publicClient.simulateContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'execute', args: [t, receipt], account: ctx.agent.address }),
    'ExceedsPerTradeCap',
  );
  if (args[0] !== t.amountIn || args[1] !== m.perTrade) throw new Error(`ExceedsPerTradeCap carried ${String(args)}`);
  // One real reverted transaction, for explorer evidence: a fixed gas limit skips estimation.
  const hash = await ctx.agent.write({ functionName: 'execute', args: [t, receipt], gas: 600_000n });
  const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'reverted') throw new Error(`over-cap tx ${hash} did not revert`);
  const after = await balances(ctx, m.usdg, rcpt.blockNumber);
  if (after.usdg !== before.usdg || after.tsla !== before.tsla) throw new Error('balances changed across a reverted over-cap trade');
  console.log(`step 3 ok: eth_call reverted ExceedsPerTradeCap(${t.amountIn}, ${m.perTrade}); tx ${hash} block ${rcpt.blockNumber} reverted; balances unchanged`);
}

export async function runAcctApprove(): Promise<void> {
  const ctx = await setup();
  await requireFreshAgent(ctx);
  const m = await market(ctx);
  const pin = await readPin(ctx);
  const amountIn = BigInt(env('APPROVAL_AMOUNT_IN', String(m.approvalAbove + 1n)));
  if (amountIn <= m.approvalAbove || amountIn > m.perTrade) throw new Error(`APPROVAL_AMOUNT_IN ${amountIn} is not in band 2 (${m.approvalAbove}, ${m.perTrade}].`);
  const { receipt, served } = await inferenceReceipt(ctx, pin, `An account may buy TSLA with ${amountIn} raw USDG, subject to owner approval. Reply BUY or HOLD.`);
  const draft = m.buy(amountIn);
  await expectRevert(
    ctx.publicClient.simulateContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'execute', args: [draft, receipt], account: ctx.agent.address }),
    'NeedsApproval',
  );
  // minOut for the owner's later fill: the canonical V4Quoter's output for this exact swap at
  // this block, less SLIPPAGE_BPS.
  const t: Trade = { ...draft, minOut: await quoterMinOut(ctx, draft) };

  const pHash = await ctx.agent.write({ functionName: 'propose', args: [t, receipt] });
  const pRcpt = await ctx.publicClient.waitForTransactionReceipt({ hash: pHash });
  if (pRcpt.status !== 'success') throw new Error(`propose tx ${pHash} reverted`);
  const proposed = parseEventLogs({ abi: agentAccountAbi, logs: pRcpt.logs, eventName: 'TradeProposed' });
  if (proposed.length !== 1) throw new Error(`propose emitted ${proposed.length} TradeProposed logs`);
  const pArgs = proposed[0].args as unknown as { proposalId: bigint; tradeHash: Hex; servedModelHash: Hex };
  if (pArgs.tradeHash !== tradeHash(t)) throw new Error(`proposal tradeHash ${pArgs.tradeHash} != local ${tradeHash(t)}`);
  if (pArgs.servedModelHash !== served) throw new Error('proposal servedModelHash does not match the receipt');
  const id = pArgs.proposalId;
  console.log(`step 4: execute reverted NeedsApproval; propose tx ${pHash} block ${pRcpt.blockNumber} -> proposal ${id}`);

  const before = await balances(ctx, m.usdg);
  const aHash = await ctx.ownerWallet.writeContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'approveTrade', args: [id, t] });
  const { log, block } = await executedLog(ctx, aHash);
  const after = await balances(ctx, m.usdg, block);
  if (log.proposalId !== id) throw new Error(`TradeExecuted.proposalId ${log.proposalId} != ${id}`);
  assertBuyDeltas(before, after, t, log, served);
  await expectRevert(
    ctx.publicClient.simulateContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'approveTrade', args: [id, t], account: ctx.owner }),
    'ProposalNotPending',
  );
  console.log(
    `step 4 ok: approveTrade tx ${aHash} block ${block} TradeExecuted(proposalId ${id}): spent ${log.amountIn}, got ${log.amountOut} TSLA; ` +
      'second approveTrade reverts ProposalNotPending',
  );
}


const verifierAbi = [
  {
    type: 'function',
    name: 'verify',
    inputs: [{ name: 'quote', type: 'bytes' }, { name: 'nonce', type: 'bytes32' }],
    outputs: [{ name: 'signer', type: 'address' }, { name: 'measurement', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
] as const;

type CvmQuote = { agent: Address; refBlock: bigint; nonce: Hex; quote: Hex };

async function cvmQuote(account: Address): Promise<CvmQuote> {
  const cvm = env('CVM_URL').replace(/\/$/, '');
  const res = await fetch(`${cvm}/quote?account=${account}`, { method: 'POST' });
  const out = fromWire<CvmQuote & { error?: string }>(await res.text());
  if (!res.ok || !out.quote) throw new Error(`CVM /quote: ${out.error ?? res.status}`);
  return out;
}

/// registerAgent with a fresh CVM quote (its ArbSys window is the last 256 blocks). Post-condition:
/// agent() is the CVM's key, admitted under `measurement`.
async function registerFresh(ctx: Ctx, measurement: Hex): Promise<{ hash: Hex; block: bigint }> {
  const fresh = await cvmQuote(ctx.account);
  if (fresh.agent.toLowerCase() !== ctx.agent.address.toLowerCase()) throw new Error('the CVM agent key changed between quotes');
  const hash = await ctx.ownerWallet.writeContract({
    address: ctx.account,
    abi: agentAccountAbi,
    functionName: 'registerAgent',
    args: [fresh.quote, fresh.refBlock],
  });
  const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`registerAgent tx ${hash} reverted`);
  const regs = parseEventLogs({ abi: agentAccountAbi, logs: rcpt.logs, eventName: 'AgentRegistered' }).filter(
    (l) => l.address.toLowerCase() === ctx.account.toLowerCase(),
  );
  if (regs.length !== 1) throw new Error(`registerAgent emitted ${regs.length} AgentRegistered logs`);
  const [agent, m, expiry] = await Promise.all([
    read<Address>(ctx, 'agent', [], rcpt.blockNumber),
    read<Hex>(ctx, 'agentMeasurement', [], rcpt.blockNumber),
    read<bigint>(ctx, 'agentExpiry', [], rcpt.blockNumber),
  ]);
  if (agent.toLowerCase() !== ctx.agent.address.toLowerCase() || m !== measurement) throw new Error(`agent() ${agent} / agentMeasurement ${m} do not match the CVM quote`);
  console.log(`registerAgent tx ${hash} block ${rcpt.blockNumber}: agent ${agent} measurement ${m} expiry ${expiry}`);
  return { hash, block: rcpt.blockNumber };
}

/// Owner side of admission. The CVM supplies the quote (its key and the account's attestNonce in
/// report_data); the Stylus Verifier is asked by eth_call which signer and measurement it
/// returns; the owner approves that measurement; registerAgent is submitted with a fresh quote
/// (the first quote's ArbSys window may have passed). Post-condition: agent() is the CVM's key.
export async function runAcctRegister(): Promise<void> {
  const ctx = await setup();
  const verifier = await read<Address>(ctx, 'verifier');
  const first = await cvmQuote(ctx.account);
  const { result } = await ctx.publicClient.simulateContract({
    address: verifier,
    abi: verifierAbi,
    functionName: 'verify',
    args: [first.quote, first.nonce],
  });
  const [signer, measurement] = result;
  if (signer.toLowerCase() !== ctx.agent.address.toLowerCase()) throw new Error(`Verifier returned signer ${signer}, the CVM reports ${ctx.agent.address}.`);
  console.log(`Verifier accepts the CVM quote: signer ${signer} measurement ${measurement} (eth_call at refBlock ${first.refBlock})`);

  let at: bigint | undefined;
  if (!(await read<boolean>(ctx, 'approvedMeasurement', [measurement]))) {
    const { hash, rcpt } = await ownerSetMeasurement(ctx, measurement, true);
    at = rcpt.blockNumber;
    console.log(`owner setMeasurement tx ${hash} block ${rcpt.blockNumber}`);
  }
  if (!(await read<boolean>(ctx, 'approvedMeasurement', [measurement], at))) throw new Error('measurement is not approved after setMeasurement');

  await registerFresh(ctx, measurement);
}


async function ownerSetMeasurement(ctx: Ctx, measurement: Hex, approved: boolean) {
  const hash = await ctx.ownerWallet.writeContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'setMeasurement', args: [measurement, approved] });
  const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error(`setMeasurement(${approved}) tx ${hash} reverted`);
  return { hash, rcpt };
}

/// Revoke by measurement. The owner withdraws approval of the measurement the registered agent was
/// admitted under; in that same transaction the account de-admits the agent (AgentRevoked, agent()
/// is zero). The agent then attempts an in-cap trade: the eth_call reverts NotAgent and one real
/// transaction reverts with balances unchanged. Re-approving the measurement does not re-admit the
/// agent; only a fresh quote does, and the last step submits one so the account stays usable.
export async function runAcctRevoke(): Promise<void> {
  const ctx = await setup();
  await requireFreshAgent(ctx);
  const m = await market(ctx);
  const pin = await readPin(ctx);
  const agentAddr = ctx.agent.address;
  const measurement = await read<Hex>(ctx, 'agentMeasurement');
  if (!(await read<boolean>(ctx, 'approvedMeasurement', [measurement]))) throw new Error('the agent was admitted under a measurement that is not approved');

  const off = await ownerSetMeasurement(ctx, measurement, false);
  const revoked = parseEventLogs({ abi: agentAccountAbi, logs: off.rcpt.logs, eventName: 'AgentRevoked' }).filter(
    (l) => l.address.toLowerCase() === ctx.account.toLowerCase(),
  );
  if (revoked.length !== 1 || (revoked[0].args as { agent: Address }).agent.toLowerCase() !== agentAddr.toLowerCase()) {
    throw new Error(`unapproving the measurement emitted ${revoked.length} AgentRevoked logs, not one for ${agentAddr}`);
  }
  const [agentNow, mNow, approvedNow] = await Promise.all([
    read<Address>(ctx, 'agent', [], off.rcpt.blockNumber),
    read<Hex>(ctx, 'agentMeasurement', [], off.rcpt.blockNumber),
    read<boolean>(ctx, 'approvedMeasurement', [measurement], off.rcpt.blockNumber),
  ]);
  if (agentNow !== '0x0000000000000000000000000000000000000000' || mNow !== `0x${'0'.repeat(64)}` || approvedNow) {
    throw new Error(`after unapproving: agent() ${agentNow}, agentMeasurement ${mNow}, approved ${approvedNow}`);
  }
  console.log(`revoke step 1 ok: owner setMeasurement(${measurement}, false) tx ${off.hash} block ${off.rcpt.blockNumber}: AgentRevoked(${agentAddr}), agent() is zero`);

  const amountIn = BigInt(env('TRADE_AMOUNT_IN', '1000000'));
  if (amountIn > m.approvalAbove) throw new Error(`TRADE_AMOUNT_IN ${amountIn} is above approvalAbove ${m.approvalAbove}: not band 1.`);
  const { receipt } = await inferenceReceipt(ctx, pin, `An account may buy TSLA with ${amountIn} raw USDG now. Reply BUY or HOLD.`);
  const t = m.buy(amountIn);
  const before = await balances(ctx, m.usdg);
  await expectRevert(
    ctx.publicClient.simulateContract({ address: ctx.account, abi: agentAccountAbi, functionName: 'execute', args: [t, receipt], account: agentAddr }),
    'NotAgent',
  );
  const txHash = await ctx.agent.write({ functionName: 'execute', args: [t, receipt], gas: 600_000n });
  const txRcpt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (txRcpt.status !== 'reverted') throw new Error(`revoked agent's trade tx ${txHash} did not revert`);
  const after = await balances(ctx, m.usdg, txRcpt.blockNumber);
  if (after.usdg !== before.usdg || after.tsla !== before.tsla) throw new Error('balances changed across a reverted revoked-agent trade');
  console.log(`revoke step 2 ok: execute by ${agentAddr} reverts NotAgent by eth_call; tx ${txHash} block ${txRcpt.blockNumber} reverted; balances unchanged`);

  const on = await ownerSetMeasurement(ctx, measurement, true);
  if ((await read<Address>(ctx, 'agent', [], on.rcpt.blockNumber)) !== '0x0000000000000000000000000000000000000000') throw new Error('re-approving the measurement re-admitted the agent');
  console.log(`revoke step 3 ok: owner setMeasurement(${measurement}, true) tx ${on.hash} block ${on.rcpt.blockNumber}; agent() is still zero`);

  const reg = await registerFresh(ctx, measurement);
  console.log(`revoke step 4 ok: registerAgent with a fresh CVM quote tx ${reg.hash} block ${reg.block}`);
}
