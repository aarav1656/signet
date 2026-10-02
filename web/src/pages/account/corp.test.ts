import { describe, expect, it } from 'vitest';
import { CORPORATE_ACTION_COOLDOWN, corporateActionLabel } from './corp';

const E18 = 10n ** 18n;

describe('corporateActionLabel', () => {
  it('is open with no change and no effective time (the live TSLA reads this)', () => {
    expect(corporateActionLabel({ current: E18, next: E18, effectiveAt: 0n }, 1_000n)).toEqual({ open: true, text: 'none pending, multiplier 1' });
  });
  it('closes while a split is pending', () => {
    const v = corporateActionLabel({ current: E18, next: 2n * E18, effectiveAt: 5_000n }, 1_000n);
    expect(v.open).toBe(false);
    expect(v.text).toMatch(/1 to 2/);
  });
  it('stays closed for the cooldown after it takes effect, then opens', () => {
    const c = { current: 2n * E18, next: 2n * E18, effectiveAt: 1_000n };
    expect(corporateActionLabel(c, 1_000n + CORPORATE_ACTION_COOLDOWN - 1n).open).toBe(false);
    expect(corporateActionLabel(c, 1_000n + CORPORATE_ACTION_COOLDOWN).open).toBe(true);
  });
});
