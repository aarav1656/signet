// Env is read by variable name only, never printed or logged. Values that
// are secrets (PHALA_API_KEY, PRIVATE_KEY) are kept as opaque strings and
// never appear in any console.log/error in this package.
import type { Address, Hex } from 'viem';
import {
  ASSAY_ADDRESS,
  CHAIN_ID,
  RPC_URL,
  USDG_ADDRESS,
} from '../../web/src/lib/addresses.generated.ts';

export const assay: Address = ASSAY_ADDRESS;
export const usdg: Address = USDG_ADDRESS;
export const chainId: number = CHAIN_ID;
export const rpcUrl: string = (process.env.RPC_URL ?? '').trim() || RPC_URL;

export const channelId: bigint = BigInt(process.env.ASSAY_CHANNEL_ID ?? '0');

// Same env var name the contracts scripts already use (script/Deploy.s.sol,
// README.md's redeploy commands): one funded key, agent and provider are the
// same address on this deployment's channel 0.
export function requirePrivateKey(): Hex {
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error('PRIVATE_KEY is not set. Put it in agent/.env or .env.');
  }
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

export function phalaApiKey(): string | undefined {
  const key = process.env.PHALA_API_KEY;
  return key && key.trim().length > 0 ? key : undefined;
}

export const phalaBaseUrl: string = (process.env.PHALA_BASE_URL ?? '').trim() || 'https://inference.phala.com';
export const phalaModel: string = (process.env.PHALA_MODEL ?? '').trim() || 'meta-llama/llama-3.3-70b-instruct';
