import { describe, expect, it } from 'vitest';
import { landedDespiteError } from './useTx';

const reader = (values: number[]) => {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
};

describe('landedDespiteError', () => {
  it('reports the nonce when the confirmed nonce passes the one read before signing', async () => {
    expect(await landedDespiteError(reader([7, 7, 8]), 7, 6, 0)).toBe(7);
  });
  it('stays undefined when nothing from the wallet landed (a real rejection)', async () => {
    expect(await landedDespiteError(reader([7, 7, 7, 7, 7, 7]), 7, 6, 0)).toBeUndefined();
  });
});
