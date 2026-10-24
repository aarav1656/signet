import { createConfig, http } from 'wagmi';
import { defineChain, type Address } from 'viem';
import { ASSAY_ADDRESS, ASSAY_DEPLOY_TX as ARB_DEPLOY_TX, CHAIN_ID, EXPLORER_URL, REGISTER_TX as ARB_REGISTER_TX, RPC_URL, USDG_ADDRESS as ARB_USDG } from './lib/addresses.generated';
import { PAXOS_USDG, RHC_CHAIN_ID, RHC_EXPLORER_URL, USDG_ASSAY, USDG_ASSAY_DEPLOY_TX, USDG_ASSAY_REGISTER_TX } from './lib/rhc.generated';

export const arbChain = defineChain({
  id: CHAIN_ID as number,
  name: 'Arbitrum Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [(import.meta.env.VITE_RPC_URL as string | undefined)?.trim() || RPC_URL] },
  },
  blockExplorers: { default: { name: 'Arbiscan', url: EXPLORER_URL } },
  contracts: { multicall3: { address: '0xca11bde05977b3631167028862bE2a173976CA11' } },
});

/** Robinhood Chain testnet: where the agent account and its factory live (contracts/deployments/46630.json). */
export const rhcChain = defineChain({
  id: RHC_CHAIN_ID as number,
  name: 'Robinhood Chain testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [(import.meta.env.VITE_RHC_RPC_URL as string | undefined)?.trim() || 'https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: { default: { name: 'Blockscout (testnet)', url: RHC_EXPLORER_URL } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

export const wagmiConfig = createConfig({
  chains: [rhcChain, arbChain],
  multiInjectedProviderDiscovery: true,
  // JSON-RPC batching: the home page fires many reads at once, and unbatched they queue behind the browser's per-host connection limit.
  transports: { [rhcChain.id]: http(undefined, { batch: { batchSize: 30, wait: 16 } }), [arbChain.id]: http(undefined, { batch: { batchSize: 30, wait: 16 } }) },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

const explorerAt = (url: string) => ({
  address: (a: string) => `${url}/address/${a}`,
  tx: (h: string) => `${url}/tx/${h}`,
  block: (n: bigint | number) => `${url}/block/${n.toString()}`,
});
export const rhcExplorer = explorerAt(RHC_EXPLORER_URL);

/// Assay is live on two networks. The Paxos USDG Assay on Robinhood Chain testnet is the default;
/// `?net=arb` reads the Arbitrum Sepolia Assay, which holds the paid calls. Verifier, receipt
/// verifier, measurement, validity and timeouts are the same on both (read from each constructor),
/// so only the fields below differ. Chosen once per page load; the header's selector reloads.
export type NetKey = 'rhc' | 'arb';
const NETS = {
  rhc: { key: 'rhc', chain: rhcChain, assay: USDG_ASSAY, usdg: PAXOS_USDG, deployTx: USDG_ASSAY_DEPLOY_TX, registerTx: USDG_ASSAY_REGISTER_TX, explorer: rhcExplorer, refWindow: 'about 39 seconds' },
  arb: { key: 'arb', chain: arbChain, assay: ASSAY_ADDRESS, usdg: ARB_USDG, deployTx: ARB_DEPLOY_TX, registerTx: ARB_REGISTER_TX, explorer: explorerAt(EXPLORER_URL), refWindow: 'about 66 seconds' },
} as const;
export const NET_KEY: NetKey = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('net') === 'arb' ? 'arb' : 'rhc';
export const assayNet = NETS[NET_KEY];
export const otherNet = NETS[NET_KEY === 'rhc' ? 'arb' : 'rhc'];
export const assayChain = assayNet.chain;
export const ASSAY: Address = assayNet.assay;
export const USDG_ADDRESS: Address = assayNet.usdg;
export const ASSAY_DEPLOY_TX = assayNet.deployTx;
export const REGISTER_TX = assayNet.registerTx;
export const explorer = assayNet.explorer;

/** The Signet pages and the agent account always read Robinhood Chain; the Assay routes read the selected network. */
export const onRhcOnly = (pathname: string) => /^\/($|agent\/|creator|account)/.test(pathname);
export const chainForPath = (pathname: string) => (onRhcOnly(pathname) ? rhcChain : assayChain);
