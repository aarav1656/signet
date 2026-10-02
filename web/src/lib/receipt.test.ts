import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReceipt, receiptKey } from './receipt';

const h = (c: string) => `0x${c.repeat(64)}` as `0x${string}`;
const base = { recorded: { requestHash: h('a'), responseHash: h('b'), served: h('c') }, pin: { requested: h('d'), accepted: [h('c')] }, consumed: true };

describe('receipt recompute', () => {
  it('is the same file the MCP server ships', () => {
    expect(readFileSync(new URL('./receipt.ts', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../../../mcp/src/receipt.ts', import.meta.url), 'utf8'));
  });
  it('passes with consumed receipt and pinned served model', () => {
    expect(checkReceipt(base).verified).toBe(true);
  });
  it('is not verified when the replay record or the pin disagrees', () => {
    expect(checkReceipt({ ...base, consumed: false }).verified).toBe(false);
    expect(checkReceipt({ ...base, pin: { requested: h('d'), accepted: [h('e')] } }).verified).toBe(false);
  });
  it('key differs when a hash changes', () => {
    expect(receiptKey(h('a'), h('b'))).not.toBe(receiptKey(h('a'), h('1')));
  });
});
