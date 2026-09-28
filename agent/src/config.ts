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

export const assay: Address = ((process.env.ASSAY_ADDRESS ?? '').trim() || ASSAY_ADDRESS) as Address;
export const usdg: Address = USDG_ADDRESS;
export const chainId: number = CHAIN_ID;
export const rpcUrl: string = (process.env.RPC_URL ?? '').trim() || RPC_URL;

export const channelId: bigint = BigInt(process.env.ASSAY_CHANNEL_ID ?? '0');

// The agent pays: it holds USDG, opens the channel and signs vouchers. Same env
// var name the contracts scripts use (script/Deploy.s.sol).
export function requirePrivateKey(): Hex {
  return requireKey('PRIVATE_KEY');
}

// The provider is paid: it registers the gateway's keys and submits redeems.
// A separate wallet, so no channel pays its own agent.
export function requireProviderKey(): Hex {
  return requireKey('PROVIDER_PRIVATE_KEY');
}

function requireKey(name: string): Hex {
  const key = process.env[name];
  if (!key) {
    throw new Error(`${name} is not set. Put it in agent/.env or the repo root .env.`);
  }
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex;
}

export function phalaApiKey(): string | undefined {
  const key = process.env.PHALA_API_KEY;
  return key && key.trim().length > 0 ? key : undefined;
}

export const phalaBaseUrl: string = (process.env.PHALA_BASE_URL ?? '').trim() || 'https://inference.phala.com';
export const phalaModel: string = (process.env.PHALA_MODEL ?? '').trim() || 'meta-llama/llama-3.3-70b-instruct';
