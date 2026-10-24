import { describe, expect, it } from 'vitest';
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { OPERATOR_CVM_URL } from '../../lib/rhc.generated';
import { readOperatorQuote } from './operator';

// Live: the operator CVM on Phala Cloud and the Stylus Verifier on Robinhood Chain testnet.
const RPC = 'https://rpc.testnet.chain.robinhood.com';
const chain = defineChain({ id: 46630, name: 'rhc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const c = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const ACCOUNT2 = '0xE1d7939105cF8B3670d6b4a0E15546C036e6c34c';
const ACCOUNT1 = '0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D';

/** A fetch that returns the live CVM answer with one field rewritten. */
const tampered = (edit: (j: Record<string, unknown>) => void): typeof fetch => async (input, init) => {
  const res = await fetch(input, init);
  const j = JSON.parse(await res.text()) as Record<string, unknown>;
  edit(j);
  return new Response(JSON.stringify(j), { status: res.status });
};

describe('readOperatorQuote', () => {
  it('reads the operator key and measurement from a quote bound to this account', async () => {
    const q = await readOperatorQuote(c, OPERATOR_CVM_URL, ACCOUNT2);
    expect(q.agent).toBe(q.signer);
    expect(q.measurement).toMatch(/^0x[0-9a-f]{64}$/);
    expect(q.measurement).not.toBe(`0x${'0'.repeat(64)}`);
  }, 60_000);

  it('refuses a quote the CVM bound to another account', async () => {
    await expect(readOperatorQuote(c, OPERATOR_CVM_URL, ACCOUNT2, tampered((j) => { j.account = ACCOUNT1; }))).rejects.toThrow(/not this account/);
  }, 60_000);

  it('refuses when the CVM reports a key the Verifier does not prove', async () => {
    await expect(readOperatorQuote(c, OPERATOR_CVM_URL, ACCOUNT2, tampered((j) => { j.agent = ACCOUNT1; }))).rejects.toThrow(/Verifier proves key/);
  }, 60_000);
});
