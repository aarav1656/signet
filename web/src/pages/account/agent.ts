import type { Address } from 'viem';
import { ZERO_ADDR } from './read';

export type AgentView = { state: 'none' } | { state: 'live'; left: number } | { state: 'expired'; ago: number };

/** Where the registered agent's attestation stands at `nowSec`. Expiry is a state, not an error. */
export function agentView(agent: Address, expiry: bigint, nowSec: number): AgentView {
  if (agent === ZERO_ADDR) return { state: 'none' };
  const left = Number(expiry) - nowSec;
  return left > 0 ? { state: 'live', left } : { state: 'expired', ago: Math.max(0, -left) };
}
