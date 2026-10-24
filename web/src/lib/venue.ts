import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from 'viem';
import { GATEWAY_MEASUREMENT, PAXOS_USDG, TEST_USDG, TSLA } from './rhc.generated';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** The model every Signet agent requests; an account pins keccak256 of this id (abi.encodePacked(string)). */
export const REQUESTED_MODEL_ID = 'meta-llama/llama-3.3-70b-instruct';
/** The label the gateway's receipt names as served for that request. */
export const SERVED_MODEL_ID = 'llama3-3-70b';
export const REQUESTED_MODEL_HASH: Hex = keccak256(toBytes(REQUESTED_MODEL_ID));

const NAMES: Record<string, string> = Object.fromEntries(
  [REQUESTED_MODEL_ID, SERVED_MODEL_ID, 'phala/qwen3.8-27b-uncensored'].map((m) => [keccak256(toBytes(m)).toLowerCase(), m]),
);
/** The model id behind a recorded hash, or undefined when the hash names a model this app does not know. */
export const modelNameOf = (hash: string): string | undefined => NAMES[hash.toLowerCase()];

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** The hookless 0.3% Paxos USDG / TSLA pool on the canonical Uniswap v4 PoolManager that every agent trades. */
export const VENUE_POOL: PoolKey = { currency0: PAXOS_USDG, currency1: TSLA, fee: 3000, tickSpacing: 60, hooks: ZERO_ADDRESS };

/** PoolManager's PoolId: keccak256 of the abi-encoded key. */
export const poolIdOf = (k: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );

export const VENUE_GATEWAY_MEASUREMENT: Hex = GATEWAY_MEASUREMENT;

/** Dollar tokens this app prices in; the Stock Token is the other leg. */
export const DOLLAR_TOKENS: readonly Address[] = [PAXOS_USDG, TEST_USDG];

const SYMBOLS: Record<string, string> = { [PAXOS_USDG.toLowerCase()]: 'USDG', [TEST_USDG.toLowerCase()]: 'USDG', [TSLA.toLowerCase()]: 'TSLA' };
/** A token address or symbol as a symbol. */
export const symbolOf = (t: string): string => SYMBOLS[t.toLowerCase()] ?? t;

export type LimitsInput = { perTrade: string; daily: string; approvalAbove: string };

/** The safety net a follower starts from. Every figure is the follower's to change before signing. */
export const DEFAULT_LIMITS: { usdg: LimitsInput; tsla: LimitsInput } = {
  usdg: { perTrade: '10', daily: '50', approvalAbove: '5' },
  tsla: { perTrade: '0.05', daily: '0.2', approvalAbove: '0.02' },
};
