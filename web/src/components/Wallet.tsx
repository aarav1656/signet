import { useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { assayChain } from '../chain';
import { short } from '../lib/format';

export function Wallet() {
  const conn = useConnection();
  const connectors = useConnectors();
  const { mutate: connect, isPending } = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain } = useSwitchChain();
  const [pickerOpen, setPickerOpen] = useState(false);

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
  const wrong = conn.chainId !== assayChain.id;
  return (
    <div className="wallet">
      {wrong && (
        <button className="btn line" onClick={() => switchChain({ chainId: assayChain.id })}>
          Switch to {assayChain.name}
        </button>
      )}
      <span className="hex">{conn.address ? short(conn.address) : 'reconnecting'}</span>
      <button className="textbtn" onClick={() => disconnect()}>
        disconnect
      </button>
    </div>
  );
}

/** True when a wallet is connected on Arbitrum Sepolia (421614). */
export function useOnChain(): { address?: `0x${string}`; ready: boolean; reason?: string } {
  const conn = useConnection();
  if (!conn.isConnected) return { ready: false, reason: 'Connect a wallet to continue.' };
  if (conn.chainId !== assayChain.id)
    return {
      address: conn.address,
      ready: false,
      reason: `Wrong network. Switch the wallet to ${assayChain.name} (id ${assayChain.id}).`,
    };
  return { address: conn.address, ready: true };
}
