import { useState } from 'react';
import { BaseError, ContractFunctionRevertedError, type Hash, type TransactionReceipt } from 'viem';
import { usePublicClient, useWriteContract } from 'wagmi';
import { rhcChain } from '../chain';
import { setTxStatus } from '../components/TxStatus';

export type TxState =
  | { phase: 'idle' }
  | { phase: 'signing'; label: string }
  | { phase: 'mining'; label: string; hash: Hash }
  | { phase: 'done'; label: string; hash: Hash; block: bigint }
  | { phase: 'failed'; label: string; message: string; hash?: Hash };

const errorName = (e: unknown): string | undefined => {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
};

export const txMessage = (e: unknown): string => {
  const name = errorName(e);
  return name ? `${name}()` : e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240);
};

/**
 * One owner transaction at a time: sign, then poll to a mined receipt and require status success.
 * A returned hash is an accepted request, so "done" only appears once the receipt says success.
 * Every phase is mirrored to the shared transaction panel.
 */
export function useTx(onDone: () => void, chainId: number = rhcChain.id) {
  const client = usePublicClient({ chainId });
  const [state, setState] = useState<TxState>({ phase: 'idle' });

  async function run(label: string, send: () => Promise<Hash>): Promise<TransactionReceipt | undefined> {
    setState({ phase: 'signing', label });
    setTxStatus({ phase: 'confirm', label, chainId });
    let hash: Hash | undefined;
    try {
      hash = await send();
      setState({ phase: 'mining', label, hash });
      setTxStatus({ phase: 'pending', label, chainId, hash });
      if (!client) throw new Error('No chain client');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 8, pollingInterval: 1_500 });
      if (receipt.status !== 'success') {
        const message = 'The transaction was mined and reverted.';
        setState({ phase: 'failed', label, hash, message });
        setTxStatus({ phase: 'failed', label, chainId, hash, reason: message });
        return undefined;
      }
      setState({ phase: 'done', label, hash, block: receipt.blockNumber });
      setTxStatus({ phase: 'confirmed', label, chainId, hash });
      onDone();
      return receipt;
    } catch (e) {
      const message = txMessage(e);
      setState({ phase: 'failed', label, hash, message });
      setTxStatus({ phase: 'failed', label, chainId, hash, reason: message });
      return undefined;
    }
  }

  return { state, run, busy: state.phase === 'signing' || state.phase === 'mining', reset: () => setState({ phase: 'idle' }) };
}

const WRITE_LABELS: Record<string, string> = {
  approve: 'Approve USDG',
  openChannel: 'Open channel',
  openChannelWithPermit: 'Open channel with permit',
  requestClose: 'Request close',
  finalizeClose: 'Finalize close',
  redeem: 'Redeem',
};

type WriteArgs = Parameters<ReturnType<typeof useWriteContract>['writeContractAsync']>[0];

/**
 * wagmi's writeContractAsync with the shared panel attached: the hash is reported as pending
 * until the receipt says success. Errors are rethrown so the caller's own error line still fires.
 */
export function useTrackedWrite(chainId: number) {
  const { writeContractAsync, isPending, data } = useWriteContract();
  const client = usePublicClient({ chainId });
  async function write(args: WriteArgs): Promise<Hash> {
    const fn = (args as { functionName: string }).functionName;
    const label = WRITE_LABELS[fn] ?? fn;
    setTxStatus({ phase: 'confirm', label, chainId });
    let hash: Hash | undefined;
    try {
      hash = await writeContractAsync(args);
      setTxStatus({ phase: 'pending', label, chainId, hash });
      if (!client) throw new Error('No chain client');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 8, pollingInterval: 1_500 });
      if (receipt.status !== 'success') {
        setTxStatus({ phase: 'failed', label, chainId, hash, reason: 'The transaction was mined and reverted.' });
        throw new Error('The transaction was mined and reverted.');
      }
      setTxStatus({ phase: 'confirmed', label, chainId, hash });
      return hash;
    } catch (e) {
      setTxStatus({ phase: 'failed', label, chainId, hash, reason: txMessage(e) });
      throw e;
    }
  }
  return { write, isPending, data };
}
