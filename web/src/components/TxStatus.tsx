import { useEffect, useSyncExternalStore } from 'react';
import { assayChain, explorer, rhcChain, rhcExplorer } from '../chain';
import { shortAddr } from './Wallet';

export type TxPhase = 'idle' | 'confirm' | 'pending' | 'confirmed' | 'failed';

export type TxInfo = {
  phase: TxPhase;
  label?: string;
  chainId?: number;
  hash?: `0x${string}`;
  reason?: string;
};

let current: TxInfo = { phase: 'idle' };
const listeners = new Set<() => void>();

/** Write the shared transaction state. Every write in the app reports through here. */
export function setTxStatus(next: TxInfo) {
  current = next;
  for (const l of listeners) l();
}

export const clearTxStatus = () => setTxStatus({ phase: 'idle' });

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export const useTxStatus = (): TxInfo => useSyncExternalStore(subscribe, () => current);

const shortReason = (r: string) => (r.length > 140 ? `${r.slice(0, 140)}...` : r);

const txUrl = (chainId: number | undefined, hash: string) => (chainId === assayChain.id ? explorer.tx(hash) : rhcExplorer.tx(hash));
export const chainName = (chainId: number | undefined) => (chainId === assayChain.id ? assayChain.name : rhcChain.name);

/** Fixed bottom-right panel: confirm in wallet, pending with the explorer link, then confirmed or failed. */
export function TxStatusPanel() {
  const tx = useTxStatus();

  useEffect(() => {
    if (tx.phase !== 'confirmed') return;
    const t = setTimeout(clearTxStatus, 8000);
    return () => clearTimeout(t);
  }, [tx.phase, tx.hash]);

  if (tx.phase === 'idle') return null;

  const title =
    tx.phase === 'confirm'
      ? 'Confirm in your wallet'
      : tx.phase === 'pending'
        ? 'Pending, waiting for the receipt'
        : tx.phase === 'confirmed'
          ? 'Confirmed'
          : `Failed: ${shortReason(tx.reason ?? 'reverted')}`;

  return (
    <div className={`tx-panel tx-${tx.phase}`} role="status" aria-live="polite">
      <div className="tx-head">
        <span className="tx-key">{tx.label ?? 'Transaction'}</span>
        {(tx.phase === 'failed' || tx.phase === 'confirmed') && (
          <button className="ctl-ghost" aria-label="Dismiss transaction status" onClick={clearTxStatus}>
            Dismiss
          </button>
        )}
      </div>
      <p className="tx-title">{title}</p>
      {tx.hash && tx.phase !== 'confirm' && (
        <a className="tx-hash mono" href={txUrl(tx.chainId, tx.hash)} target="_blank" rel="noreferrer">
          {shortAddr(tx.hash)} on {chainName(tx.chainId)}
        </a>
      )}
    </div>
  );
}
