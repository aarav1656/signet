import { createConfig, http } from 'wagmi';
import { defineChain, type Address } from 'viem';
import { injected, walletConnect } from 'wagmi/connectors';
import { ASSAY_ADDRESS, CHAIN_ID, EXPLORER_URL, RPC_URL } from './lib/addresses.generated';

export const assayChain = defineChain({
  id: CHAIN_ID as number,
  name: 'Arbitrum Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [(import.meta.env.VITE_RPC_URL as string | undefined)?.trim() || RPC_URL] },
  },
  blockExplorers: { default: { name: 'Arbiscan', url: EXPLORER_URL } },
  contracts: { multicall3: { address: '0xca11bde05977b3631167028862bE2a173976CA11' } },
});

export const ASSAY: Address = ASSAY_ADDRESS;

const wcProjectId = (import.meta.env.VITE_WC_PROJECT_ID as string | undefined)?.trim();

export const wagmiConfig = createConfig({
  chains: [assayChain],
  connectors: [
    injected(),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
  ],
  transports: { [assayChain.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export const explorer = {
  address: (a: string) => `${EXPLORER_URL}/address/${a}`,
  tx: (h: string) => `${EXPLORER_URL}/tx/${h}`,
  block: (n: bigint | number) => `${EXPLORER_URL}/block/${n.toString()}`,
};
