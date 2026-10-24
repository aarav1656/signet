// Follow a creator: leave exactly one measurement approved on the follower's account, the
// creator's. approvedMeasurement is a set, so following is not one approval but a sweep: read
// every measurement the owner ever set (MeasurementSet logs from the deployment block), withdraw
// every approval except the followed one, then approve it. Both calls are the existing onlyOwner
// setMeasurement. Withdrawing the measurement the current agent was admitted under revokes that
// agent in the same transaction, so switching creators never leaves the old creator trading.
// Post-condition, read back at the last block: the followed measurement is the only one approved.
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { agentAccountAbi } from './account-abi.ts';

const MEASUREMENT_SET = parseAbiItem('event MeasurementSet(bytes32 indexed measurement, bool approved)');

const LOG_RANGE = 5_000_000n; // the Robinhood Chain RPC allows 10M blocks per getLogs
const MAX_PAGES = 200;

/// Every measurement the owner ever set on `account`, oldest page first. Bounded below by
/// `fromBlock` (the deployment block) and by MAX_PAGES pages of LOG_RANGE blocks.
export async function measurementsSet(publicClient: PublicClient, account: Address, fromBlock: bigint): Promise<Hex[]> {
  const head = await publicClient.getBlockNumber();
  if ((head - fromBlock) / LOG_RANGE >= BigInt(MAX_PAGES)) throw new Error(`fromBlock ${fromBlock} is more than ${MAX_PAGES} pages behind the head ${head}`);
  const found: Hex[] = [];
  for (let from = fromBlock; from <= head; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < head ? from + LOG_RANGE - 1n : head;
    const logs = await publicClient.getLogs({ address: account, event: MEASUREMENT_SET, fromBlock: from, toBlock: to });
    found.push(...logs.map((l) => l.args.measurement as Hex));
  }
  return found;
}

export type FollowResult = { followed: Hex; revoked: Hex[]; approvedTx?: Hex; revokeTxs: Hex[]; seen: Hex[] };

/// Pure plan: revoke every approved measurement but the followed one; approve it if it is not yet.
export function planFollow(approvedNow: readonly Hex[], followed: Hex): { revoke: Hex[]; approve: boolean } {
  const f = followed.toLowerCase();
  return { revoke: approvedNow.filter((m) => m.toLowerCase() !== f), approve: !approvedNow.some((m) => m.toLowerCase() === f) };
}

export async function follow(
  publicClient: PublicClient,
  ownerWallet: WalletClient,
  account: Address,
  followed: Hex,
  fromBlock: bigint,
): Promise<FollowResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(followed) || /^0x0+$/.test(followed)) throw new Error('followed measurement must be a non-zero bytes32');
  const isApproved = (m: Hex, blockNumber?: bigint) =>
    publicClient.readContract({ address: account, abi: agentAccountAbi, functionName: 'approvedMeasurement', args: [m], ...(blockNumber === undefined ? {} : { blockNumber }) }) as Promise<boolean>;

  const logged = await measurementsSet(publicClient, account, fromBlock);
  const seen = [...new Set([...logged, followed.toLowerCase() as Hex])];
  const flags = await Promise.all(seen.map((m) => isApproved(m)));
  const approvedNow = seen.filter((_, i) => flags[i]);
  if (approvedNow.length === 0 && logged.length === 0) throw new Error(`no MeasurementSet logs for ${account} from block ${fromBlock}: wrong account or fromBlock`);

  const plan = planFollow(approvedNow, followed);
  const send = async (m: Hex, approved: boolean) => {
    const hash = await ownerWallet.writeContract({ account: ownerWallet.account!, chain: ownerWallet.chain, address: account, abi: agentAccountAbi, functionName: 'setMeasurement', args: [m, approved] });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== 'success') throw new Error(`setMeasurement(${m}, ${approved}) tx ${hash} reverted`);
    return { hash, block: rcpt.blockNumber };
  };
  // Withdraw first: at no point are two measurements approved.
  const revokeTxs: Hex[] = [];
  let last = 0n;
  for (const m of plan.revoke) {
    const t = await send(m, false);
    revokeTxs.push(t.hash);
    last = t.block;
  }
  let approvedTx: Hex | undefined;
  if (plan.approve) {
    const t = await send(followed, true);
    approvedTx = t.hash;
    last = t.block;
  }
  if (last === 0n) return { followed, revoked: [], revokeTxs, seen };

  // Retry reads pinned to the last block: the answering RPC node can be a block behind.
  for (let attempt = 0; ; attempt++) {
    try {
      const after = await Promise.all(seen.map((m) => isApproved(m, last)));
      const still = seen.filter((_, i) => after[i]);
      if (still.length !== 1 || still[0].toLowerCase() !== followed.toLowerCase()) throw new Error(`after follow, approved measurements are [${still.join(', ')}], expected only ${followed}`);
      break;
    } catch (e) {
      if (attempt >= 20 || (e instanceof Error && e.message.startsWith('after follow'))) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { followed, revoked: plan.revoke, approvedTx, revokeTxs, seen };
}

function env(name: string, fallback?: string): string {
  const v = (process.env[name] ?? '').trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is not set.`);
}

/// `npm run acct-follow`: ACCOUNT_ADDRESS, FOLLOW_MEASUREMENT, OWNER_PRIVATE_KEY, and optionally
/// RHC_RPC_URL, RHC_CHAIN_ID and FROM_BLOCK (default: the deployment block in
/// contracts/deployments/<chain>.json).
export async function runAcctFollow(): Promise<void> {
  const rpc = env('RHC_RPC_URL', 'https://rpc.testnet.chain.robinhood.com');
  const chainId = Number(env('RHC_CHAIN_ID', '46630'));
  const chain = defineChain({ id: chainId, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const key = env('OWNER_PRIVATE_KEY');
  const owner = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as Hex);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(rpc) });
  const account = env('ACCOUNT_ADDRESS') as Address;
  const id = await publicClient.getChainId();
  if (id !== chainId) throw new Error(`RPC chain id ${id}, expected ${chainId}`);
  const accountOwner = (await publicClient.readContract({ address: account, abi: agentAccountAbi, functionName: 'owner' })) as Address;
  if (accountOwner.toLowerCase() !== owner.address.toLowerCase()) throw new Error(`account owner() is ${accountOwner}, not the configured owner key.`);
  const fromBlock = BigInt(env('FROM_BLOCK', '') || (JSON.parse(readFileSync(new URL(`../../contracts/deployments/${chainId}.json`, import.meta.url), 'utf8')) as { block: number }).block);
  const r = await follow(publicClient, ownerWallet, account, env('FOLLOW_MEASUREMENT') as Hex, fromBlock);
  console.log(`follow ok: ${account} approves only ${r.followed}; withdrew ${r.revoked.length} (${r.revoked.join(', ') || 'none'}); ${r.approvedTx ? `approved in ${r.approvedTx}` : 'already approved'}; ${r.seen.length} measurements seen`);
}
