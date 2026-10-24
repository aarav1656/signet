import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { DEMO_ACCOUNT } from '../../lib/rhc.generated';
import { matches, OPERATOR_ACCOUNTS, readTour, TX } from './readTour';

const RPC = 'https://rpc.testnet.chain.robinhood.com';
const chain = defineChain({ id: 46630, name: 'rhc', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } } });
const c = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
const EXPECT = { admit: 'success', stolenSigner: 'reverted', create: 'success', trade: 'success', overCap: 'reverted', approve: 'success', wrongModel: 'reverted' } as const;

describe('judge tour', () => {
  it('every tour hash is recorded in the deployment record', () => {
    const record = readFileSync(new URL('../../../../contracts/deployments/46630.json', import.meta.url), 'utf8').toLowerCase();
    for (const h of Object.values(TX)) expect(record.includes(h.toLowerCase()), h).toBe(true);
  });

  it('reads every step live and each one matches what the tour claims', async () => {
    const block = await c.getBlockNumber();
    const t = await readTour(c, block);
    for (const [k, want] of Object.entries(EXPECT)) expect(matches(t.receipts[k as keyof typeof TX], want), k).toBe(true);
    expect(t.created?.toLowerCase()).toBe(DEMO_ACCOUNT.toLowerCase());
    expect(t.operatorAgents).toHaveLength(OPERATOR_ACCOUNTS.length);
    expect(new Set(t.operatorAgents.map((x) => x.agent.toLowerCase())).size).toBe(1);
    expect(t.operatorAgents[0].agent.toLowerCase()).toBe(t.agent.toLowerCase());
    expect(t.verifierPrefix.startsWith('0xeff0')).toBe(true);
    expect(t.trade?.amountIn).toBe(1_000_000n);
    expect(t.approved?.proposalId).toBe(1n);
    expect(t.wrongModelPaid).toBe(0n);
    expect(t.corp.cooldown).toBe(86_400n);
    expect(t.receipts.stolenSigner.gasUsed).toBe(2_349_054n);
  }, 60_000);

  it('a row with the wrong expectation does not resolve', () => {
    expect(matches({ hash: TX.overCap, status: 'reverted', block: 1n, gasUsed: 1n }, 'success')).toBe(false);
    expect(matches(undefined, 'success')).toBe(false);
  });
});
