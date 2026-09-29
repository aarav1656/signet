import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ASSAY, assayChain, explorer, wagmiConfig } from './chain';
import { Wallet } from './components/Wallet';
import { Overview } from './pages/Overview';
import { Verify } from './pages/Verify';
import { Channel } from './pages/Channel';

const queryClient = new QueryClient();

function Page() {
  const loc = useLocation();
  return (
    <div className="route" key={loc.pathname}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/channel" element={<Channel />} />
      </Routes>
    </div>
  );
}

export function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <div className="shell">
            <header className="top">
              <NavLink to="/" className="wordmark">
                Chiron
              </NavLink>
              <nav className="nav" aria-label="Primary">
                <NavLink to="/" end>
                  Refusal
                </NavLink>
                <NavLink to="/channel">Channels</NavLink>
                <NavLink to="/verify">Verify a gateway</NavLink>
              </nav>
              <Wallet />
            </header>
            <Page />
            <footer className="foot">
              <span>
                Chiron on {assayChain.name}, chain {assayChain.id}. Every figure is a chain read at the block shown beside it.
              </span>
              <a href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">
                Assay on the explorer
              </a>
            </footer>
          </div>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
