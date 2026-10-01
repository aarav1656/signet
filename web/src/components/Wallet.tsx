import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { assayChain, chainForPath } from '../chain';
import { short } from '../lib/format';

export function Wallet() {
  const conn = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain } = useSwitchChain();
  const [pickerOpen, setPickerOpen] = useState(false);
  const target = chainForPath(useLocation().pathname);

  if (!conn.isConnected) {
    return (
      <div className="wallet">
        <button
          className="btn"
          disabled={isPending || connectors.length === 0}
          onClick={() => (connectors.length === 1 ? connect({ connector: connectors[0] }) : setPickerOpen((v) => !v))}
        >
          {isPending ? 'Connecting' : 'Connect wallet'}
        </button>
        {pickerOpen && connectors.length > 1 && (
          <div className="wallet-menu" role="menu">
            {connectors.map((c) => (
              <button
                key={c.uid}
                className="wallet-menu-item"
                role="menuitem"
                onClick={() => {
                  setPickerOpen(false);
                  connect({ connector: c });
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  const wrong = conn.chainId !== target.id;
  return (
    <div className="wallet">
      {wrong && (
        <button className="btn line" onClick={() => switchChain({ chainId: target.id })}>
          Switch to {target.name}
        </button>
      )}
      <span className="hex">{conn.address ? short(conn.address) : 'reconnecting'}</span>
      <button className="textbtn" onClick={() => disconnect()}>
        disconnect
      </button>
    </div>
  );
}

/** True when a wallet is connected on `chain` (Arbitrum Sepolia 421614 unless the caller names another). */
export function useOnChain(chain: { id: number; name: string } = assayChain): { address?: `0x${string}`; ready: boolean; reason?: string } {
  const conn = useConnection();
  if (!conn.isConnected) return { ready: false, reason: 'Connect a wallet to continue.' };
  if (conn.chainId !== chain.id)
    return {
      address: conn.address,
      ready: false,
      reason: `Wrong network. Switch the wallet to ${chain.name} (id ${chain.id}).`,
    };
  return { address: conn.address, ready: true };
}
