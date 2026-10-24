import { describe, expect, it } from 'vitest';
import { pricingNote } from './Leaderboard';

describe('pricingNote', () => {
  it('keeps the prose and drops sentences that name record fields', () => {
    const note = 'Stock Token legs are priced from the round current at each trade. Quote assets count 1 USD. pnlUsd marks the net position at the latest round; pnlAtTradeUsd values each trade.';
    expect(pricingNote(note)).toBe(' Stock Token legs are priced from the round current at each trade. Quote assets count 1 USD.');
  });
  it('is empty without a note', () => {
    expect(pricingNote(undefined)).toBe('');
  });
});
