import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { getAddress, isAddress } from 'viem';
import { BrowserRouter, NavLink, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { ASSAY, assayChain, chainForPath, explorer, rhcExplorer, wagmiConfig } from './chain';
import { DEMO_ACCOUNT } from './lib/rhc.generated';
import { Wallet } from './components/Wallet';
import { TxStatusPanel } from './components/TxStatus';
import { Account } from './pages/Account';
import { Overview } from './pages/Overview';
import { Verify } from './pages/Verify';
import { Channel } from './pages/Channel';

const queryClient = new QueryClient();

function Footer() {
  const chain = chainForPath(useLocation().pathname);
  const onAccount = chain !== assayChain;
  return (
    <footer className="foot">
      <span>
        Chiron on {chain.name}, chain {chain.id}. Every figure is a chain read at the block shown beside it.
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
  return (
    <aside className="rail">
      <NavLink to="/" className="mark" aria-label="Chiron, the account" />
      <a className="rail-acct" href={rhcExplorer.address(account)} target="_blank" rel="noreferrer" title={account}>
        Account {account.slice(0, 6)}...{account.slice(-4)}
      </a>
    </aside>
  );
}

function Page() {
  const loc = useLocation();
  return (
    <div className="route" key={loc.pathname}>
      <Routes>
        <Route path="/" element={<Account />} />
        <Route path="/refusal" element={<Overview />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/channel" element={<Channel />} />
      </Routes>
    </div>
  );
}

function Header() {
  const chain = chainForPath(useLocation().pathname);
  return (
    <header className="top">
      <NavLink to="/" className="wordmark">
        CHIRON
      </NavLink>
      <nav className="nav" aria-label="Primary">
        <NavLink to="/" end>
          Account
        </NavLink>
        <NavLink to="/refusal">Refusal</NavLink>
        <NavLink to="/channel">Channels</NavLink>
        <NavLink to="/verify">Verify a gateway</NavLink>
      </nav>
      <span className="net">
        {chain.name} · {chain.id}
      </span>
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
