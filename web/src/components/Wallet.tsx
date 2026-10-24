import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { assayChain, chainForPath } from '../chain';

/** Curated EIP-6963 wallets only, in presentation order. Anything else the browser
 * announces is hidden so the menu never becomes a phishing list. */
export const WALLET_ALLOWLIST = [
  { rdns: 'io.rabby', label: 'Rabby' },
  { rdns: 'io.metamask', label: 'MetaMask' },
  { rdns: 'com.coinbase.wallet', label: 'Coinbase Wallet' },
  { rdns: 'app.phantom', label: 'Phantom' },
] as const;

const ORDER = new Map<string, number>(WALLET_ALLOWLIST.map((w, i) => [w.rdns, i]));

export function walletLabel(rdns: string): string {
  return WALLET_ALLOWLIST.find((w) => w.rdns === rdns)?.label ?? rdns;
}

type Connectable = { rdns?: string | readonly string[] | undefined; id?: string };

/**
 * The allowlisted rdns a connector stands for. wagmi builds an EIP-6963 connector with id = the wallet's
 * rdns and no rdns field, so the id is read when the field is absent.
 */
export function rdnsOf(c: Connectable): string | undefined {
  const r = c.rdns ?? c.id;
  if (typeof r === 'string') return ORDER.has(r) ? r : undefined;
  if (Array.isArray(r)) return r.find((x) => ORDER.has(x));
  return undefined;
}

/** Keep only allowlisted EIP-6963 connectors, sorted in allowlist order. */
export function filterAllowedConnectors<T extends Connectable>(connectors: readonly T[]): T[] {
  return connectors
    .filter((c) => rdnsOf(c) !== undefined)
    .sort((a, b) => (ORDER.get(rdnsOf(a) as string) ?? 99) - (ORDER.get(rdnsOf(b) as string) ?? 99));
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

const codeOf = (e: unknown): number | undefined => {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) {
    if (typeof x.code === 'number') return x.code;
  }
  return undefined;
};

/** What to tell the person when a wallet connection does not complete, by EIP-1193 error code. */
export function connectHint(e: unknown, wallet: string): string {
  const code = codeOf(e);
  if (code === 4001) return `${wallet} did not approve. Open ${wallet}, unlock it if it is locked, approve the connection, then try again.`;
  if (code === -32002) return `A connection request is already waiting in ${wallet}. Open ${wallet} to approve it.`;
  return `${wallet} did not connect. Open ${wallet}, check it is unlocked, then try again.`;
}

export function Wallet() {
  const conn = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connectAsync, isPending } = useConnect();
  const [hint, setHint] = useState('');
  const { mutate: disconnect } = useDisconnect();
  const { mutate: switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const target = chainForPath(useLocation().pathname);

  const allowed = filterAllowedConnectors(connectors);

  // A locked Rabby answers wallet_requestPermissions with 4001 and no popup; eth_requestAccounts
  // raises its unlock prompt, so one retry through it, then a message that says what to do.
  async function connectTo(c: (typeof allowed)[number]) {
    setHint('');
    const label = walletLabel(rdnsOf(c) as string);
    try {
      await connectAsync({ connector: c });
    } catch (e) {
      if (codeOf(e) !== 4001) return setHint(connectHint(e, label));
      try {
        const provider = (await c.getProvider()) as { request: (a: { method: string }) => Promise<unknown> };
        await provider.request({ method: 'eth_requestAccounts' });
        await connectAsync({ connector: c });
      } catch (e2) {
        setHint(connectHint(e2, label));
      }
    }
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (conn.isConnected) setOpen(false);
  }, [conn.isConnected]);

  if (!conn.isConnected) {
    return (
      <div className="wallet" ref={rootRef}>
        <button className="ctl" aria-haspopup="menu" aria-expanded={open} disabled={isPending} onClick={() => setOpen((v) => !v)}>
          {isPending ? 'Connecting' : 'Connect wallet'}
        </button>
        {open && (
          <div className="wallet-menu" role="menu" aria-label="Browser wallets">
            {allowed.length === 0 ? (
              <div className="wallet-empty">
                <span>No browser wallet found</span>
                <a href="https://rabby.io" target="_blank" rel="noreferrer">Get Rabby</a>
              </div>
            ) : (
              allowed.map((c) => (
                <button key={c.uid} className="wallet-item" role="menuitem" disabled={isPending} onClick={() => connectTo(c)}>
                  {walletLabel(rdnsOf(c) as string)}
                </button>
              ))
            )}
            {hint && <p className="wallet-err" role="alert">{hint}</p>}
          </div>
        )}
      </div>
    );
  }
  const wrong = conn.chainId !== target.id;
  return (
    <div className="wallet">
      {wrong && (
        <button className="ctl warn" onClick={() => switchChain({ chainId: target.id })}>
          Switch to {target.name}
        </button>
      )}
      <span className="addr">{conn.address ? shortAddr(conn.address) : 'reconnecting'}</span>
      <button className="ctl-ghost" onClick={() => disconnect()}>Disconnect</button>
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
