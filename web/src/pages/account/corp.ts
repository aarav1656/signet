import type { CorporateAction } from './read';

/** Mirrors AgentAccount.CORPORATE_ACTION_COOLDOWN. */
export const CORPORATE_ACTION_COOLDOWN = 86_400n;

const ratio = (m: bigint) => (Number(m) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 4 });

/** What the account's ERC-8056 guard sees for this token at `now` (unix seconds). */
export function corporateActionLabel(c: CorporateAction, now: bigint): { open: boolean; text: string } {
  if (c.next !== c.current) return { open: false, text: `pending: multiplier ${ratio(c.current)} to ${ratio(c.next)}, agent trades paused` };
  if (c.effectiveAt !== 0n && now < c.effectiveAt + CORPORATE_ACTION_COOLDOWN) {
    return { open: false, text: `multiplier ${ratio(c.current)} took effect, agent trades resume one day after` };
  }
  return { open: true, text: `none pending, multiplier ${ratio(c.current)}` };
}
