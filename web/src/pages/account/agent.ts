import type { Address } from 'viem';
import { ZERO_ADDR } from './read';

export type AgentView =
  | { state: 'none' }
  | { state: 'live'; left: number }
  | { state: 'near'; left: number }
  | { state: 'expired'; ago: number };

/** Inside this many seconds of expiry the keeper's renewal is due. */
export const NEAR_EXPIRY_SEC = 2 * 3600;

/** Where the registered agent's attestation stands at `nowSec`. Expiry is a state, not an error. */
export function agentView(agent: Address, expiry: bigint, nowSec: number): AgentView {
  if (agent === ZERO_ADDR) return { state: 'none' };
  const left = Number(expiry) - nowSec;
  if (left <= 0) return { state: 'expired', ago: nowSec - Number(expiry) };
  return left <= NEAR_EXPIRY_SEC ? { state: 'near', left } : { state: 'live', left };
}
