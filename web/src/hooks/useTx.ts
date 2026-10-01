import { useState } from 'react';
import { BaseError, ContractFunctionRevertedError, type Hash, type TransactionReceipt } from 'viem';
import { usePublicClient } from 'wagmi';
import { rhcChain } from '../chain';

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

/**
 * One owner transaction at a time: sign, then poll to a mined receipt and require status success.
 * A returned hash is an accepted request, so "done" only appears once the receipt says success.
 */
export function useTx(onDone: () => void) {
  const client = usePublicClient({ chainId: rhcChain.id });
  const [state, setState] = useState<TxState>({ phase: 'idle' });

  async function run(label: string, send: () => Promise<Hash>): Promise<TransactionReceipt | undefined> {
    setState({ phase: 'signing', label });
    let hash: Hash | undefined;
    try {
      hash = await send();
      setState({ phase: 'mining', label, hash });
      if (!client) throw new Error('No Robinhood Chain client');
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000, retryCount: 8, pollingInterval: 1_500 });
      if (receipt.status !== 'success') {
        setState({ phase: 'failed', label, hash, message: 'The transaction was mined and reverted.' });
        return undefined;
      }
      setState({ phase: 'done', label, hash, block: receipt.blockNumber });
      onDone();
      return receipt;
    } catch (e) {
      const name = errorName(e);
      const message = name ? `${name}()` : e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240);
      setState({ phase: 'failed', label, hash, message });
      return undefined;
    }
  }

  return { state, run, busy: state.phase === 'signing' || state.phase === 'mining', reset: () => setState({ phase: 'idle' }) };
}
