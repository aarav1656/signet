import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { getAddress, isAddress } from 'viem';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { ASSAY, assayNet, chainForPath, explorer, NET_KEY, onRhcOnly, otherNet, rhcChain, rhcExplorer, wagmiConfig } from './chain';
import { DEMO_ACCOUNT } from './lib/rhc.generated';
import { Wallet } from './components/Wallet';
import { TxStatusPanel } from './components/TxStatus';
import { Account } from './pages/Account';
import { Overview } from './pages/Overview';
import { Verify } from './pages/Verify';
import { Channel } from './pages/Channel';
import { Creator } from './pages/signet/Creator';
import { Profile } from './pages/signet/Profile';
import { Signet } from './pages/signet/Signet';

const queryClient = new QueryClient();

function Footer() {
  const { pathname } = useLocation();
  const chain = chainForPath(pathname);
  const onAccount = onRhcOnly(pathname);
  return (
    <footer className="foot">
      <span>
        Signet on {chain.name}, chain {chain.id}, built on attested AgentAccounts. Every figure is a chain read at the block shown beside it.
      </span>
      <a href={onAccount ? rhcExplorer.address(DEMO_ACCOUNT) : explorer.address(ASSAY)} target="_blank" rel="noreferrer">
        {onAccount ? 'The deployed account on the explorer' : 'Assay on the explorer'}
      </a>
    </footer>
  );
}

/** The thin left rail: the mark, and the account the page is reading, set vertically. */
function Rail() {
  const [params] = useSearchParams();
  const raw = params.get('account') ?? '';
  const account = isAddress(raw) ? getAddress(raw) : DEMO_ACCOUNT;
  const onAccountPage = useLocation().pathname === '/account';
  return (
    <aside className="rail">
      <NavLink to="/" className="mark" aria-label="Signet, the attested agents" />
      {onAccountPage ? (
        <a className="rail-acct" href={rhcExplorer.address(account)} target="_blank" rel="noreferrer" title={account}>
          Account {account.slice(0, 6)}...{account.slice(-4)}
        </a>
      ) : (
        <span className="rail-acct">Robinhood Chain testnet {rhcChain.id}</span>
      )}
    </aside>
  );
}

function Page() {
  const loc = useLocation();
  return (
    <div className="route" key={loc.pathname}>
      <Routes>
        <Route path="/" element={<Signet />} />
        <Route path="/agent/:measurement" element={<Profile />} />
        <Route path="/creator" element={<Creator />} />
        <Route path="/account" element={<Account />} />
        <Route path="/refusal" element={<Overview />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/channel" element={<Channel />} />
      </Routes>
    </div>
  );
}

/** Which chain this view reads. The account is always on Robinhood Chain; the Assay routes offer both networks. */
function NetBar() {
  const { pathname } = useLocation();
  if (onRhcOnly(pathname)) return null;
  const link = (key: string) => `${pathname}?net=${key}`;
  return (
    <p className="netbar" role="group" aria-label="Assay network">
      <span className="t-label">Assay on</span>
      {(['rhc', 'arb'] as const).map((k) => {
        const n = k === NET_KEY ? assayNet : otherNet;
        return (
          <a key={k} href={link(k)} aria-current={k === NET_KEY ? 'true' : undefined} className={k === NET_KEY ? 'on' : undefined}>
            {n.chain.name} · {n.chain.id}
          </a>
        );
      })}
      <span className="small">{NET_KEY === 'rhc' ? 'Paxos USDG, next to the account' : 'the network with the paid inference calls'}</span>
    </p>
  );
}

function Header() {
  return (
    <header className="top">
      <NavLink to="/" className="wordmark">
        SIGNET
      </NavLink>
      <nav className="nav" aria-label="Primary">
        <NavLink to="/" end>
          Agents
        </NavLink>
        <NavLink to="/creator">Publish</NavLink>
        <NavLink to="/account">Account</NavLink>
        <NavLink to="/refusal">Refusal</NavLink>
        <NavLink to="/channel">Channels</NavLink>
        <NavLink to="/verify">Verify a gateway</NavLink>
      </nav>
      <Wallet />
    </header>
  );
}

export function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <div className="shell">
            <Rail />
            <main className="main">
              <Header />
              <NetBar />
              <Page />
              <Footer />
            </main>
          </div>
          <TxStatusPanel />
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
