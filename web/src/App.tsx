import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { ASSAY, assayChain, explorer, wagmiConfig } from './chain';
import { Wallet } from './components/Wallet';
import { Providers } from './pages/Providers';
import { Verify } from './pages/Verify';
import { Channel } from './pages/Channel';

const queryClient = new QueryClient();

export function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <div className="shell">
            <header className="top">
              <NavLink to="/" className="brand">
                <span className="mark" aria-hidden="true">C</span>
                Chiron <em>attested settlement</em>
              </NavLink>
              <nav className="pillnav" aria-label="Primary">
                <NavLink to="/" end>
                  Providers
                </NavLink>
                <NavLink to="/verify">Verify</NavLink>
                <NavLink to="/channel">Channel</NavLink>
                <a className="ext" href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">
                  Contract
                </a>
              </nav>
              <Wallet />
            </header>
            <Routes>
              <Route path="/" element={<Providers />} />
              <Route path="/verify" element={<Verify />} />
              <Route path="/channel" element={<Channel />} />
            </Routes>
            <footer className="foot">
              <span>
                Chiron on {assayChain.name} ({assayChain.id})
              </span>
              <a href={explorer.address(ASSAY)} target="_blank" rel="noreferrer">
                Assay contract
              </a>
            </footer>
          </div>
        </BrowserRouter>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
