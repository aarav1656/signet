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
// CHAIN_ID overrides the chain the register/open/pay modes sign for, e.g. 46630 for RHC testnet.
export const chainId: number = Number((process.env.CHAIN_ID ?? '').trim()) || CHAIN_ID;
export const rpcUrl: string = (process.env.RPC_URL ?? '').trim() || RPC_URL;

export const channelId: bigint = BigInt(process.env.ASSAY_CHANNEL_ID ?? '0');

// ChironGate / x402BatchSettlement / ERC3009DepositCollector: live Arbitrum Sepolia
// deployment (the official x402 bytecode, redeployed by us at its CREATE2 address).
// `assay` above doubles as the ChironGate `registry` (same contract, same
// receiptSigners/receiptVerifier the old redeemWithReceipt path used).
export const gate: Address = ((process.env.GATE_ADDRESS ?? '').trim() || '0xA5b57CA7961A96E75E3Ed1915F5677382d44F24e') as Address;
export const x402: Address = ((process.env.X402_ADDRESS ?? '').trim() || '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003') as Address;
export const erc3009Collector: Address = ((process.env.COLLECTOR_ADDRESS ?? '').trim() || '0x4020806089470a89826cB9fB1f4059150b550004') as Address;
// The measurement Assay was deployed with (APPROVED_MEASUREMENTS[0] in
// web/src/lib/addresses.generated.ts); ChironGate pins claims to it.
export const gateMeasurement: Hex = '0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149';

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

export const phalaMaxTokens: number = Number((process.env.PHALA_MAX_TOKENS ?? '').trim() || '8');
