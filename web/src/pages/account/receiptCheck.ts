import { useQuery } from '@tanstack/react-query';
import { decodeFunctionData, type Address, type Hex, type PublicClient } from 'viem';
import { usePublicClient } from 'wagmi';
import { rhcChain } from '../../chain';
import { accountAbi } from '../../abi/AgentAccount.generated';
import { checkReceipt, receiptKey, type Check } from '../../lib/receipt';
import type { AccountLog, GateRow } from './gateRows';

export type ReceiptState = { state: 'checking' } | { state: 'verified'; checks: Check[] } | { state: 'not-verified'; checks: Check[]; reason?: string };

const ZERO32 = `0x${'0'.repeat(64)}`;

/** The account's latest model pin, from its ModelSet events. */
export function latestPin(logs: AccountLog[]): { requested: Hex; accepted: Hex[] } | undefined {
  const m = [...logs].reverse().find((l) => l.eventName === 'ModelSet');
  if (!m) return undefined;
  const a = m.args as { requestedModelHash: Hex; acceptedServedHashes: Hex[] };
  return { requested: a.requestedModelHash, accepted: a.acceptedServedHashes.filter((h) => h !== ZERO32) };
}

/** Recompute one trade's receipt hash in the browser from its calldata and compare it with what the chain recorded. */
export async function recheck(c: PublicClient, account: Address, row: GateRow, pin: { requested: Hex; accepted: Hex[] }): Promise<ReceiptState> {
  const rc = row.receipt;
  if (!rc) return { state: 'not-verified', checks: [], reason: 'no receipt on this row' };
  const tx = await c.getTransaction({ hash: rc.carrierTx });
  let receiptBytes: Hex | undefined;
  try {
    const fn = decodeFunctionData({ abi: accountAbi, data: tx.input });
    if (fn.functionName === 'execute' || fn.functionName === 'propose') receiptBytes = (fn.args as unknown as readonly [unknown, { receiptBytes: Hex }])[1].receiptBytes;
  } catch {
    // not a direct account call
  }
  const consumed = await c.readContract({ address: account, abi: accountAbi, functionName: 'usedReceipt', args: [receiptKey(rc.requestHash, rc.responseHash)] });
  const res = checkReceipt({ recorded: { requestHash: rc.requestHash, responseHash: rc.responseHash, served: rc.served }, receiptBytes, pin, consumed });
  const carried = res.checks.some((k) => k.name === 'receipt_hash_matches');
  return res.verified && carried ? { state: 'verified', checks: res.checks } : { state: 'not-verified', checks: res.checks, reason: carried ? undefined : 'receipt bytes not in the transaction calldata' };
}

/** Default is not-verified: a row shows verified only after every recomputed check passes. */
export function useReceiptCheck(account: Address, row: GateRow, logs: AccountLog[]): ReceiptState | undefined {
  const client = usePublicClient({ chainId: rhcChain.id });
  const pin = latestPin(logs);
  const q = useQuery({
    queryKey: ['receipt-check', account, row.key],
    enabled: !!client && !!row.receipt && !!pin,
    staleTime: Infinity,
    retry: 1,
    queryFn: () => recheck(client as PublicClient, account, row, pin!),
  });
  if (!row.receipt) return undefined;
  if (q.isError) return { state: 'not-verified', checks: [], reason: 'could not read the chain' };
  return q.data ?? { state: 'checking' };
}
