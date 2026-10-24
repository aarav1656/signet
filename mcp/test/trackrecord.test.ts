import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legs, selectTrackRecord, summarize, venuePrice, type TokenInfo, type Trade, type TrackRecord } from '../src/trackrecord.js';

const Q = '0x7E955252E15c84f5768B83c41a71F9eba181802F'; // quote, 6 decimals
const S = '0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E'; // stock, 18 decimals
const TOKENS: Record<string, TokenInfo> = { [Q.toLowerCase()]: { decimals: 6, kind: 'quote' }, [S.toLowerCase()]: { decimals: 18, kind: 'stock' } };
const oracle = { roundId: '1', updatedAt: 1, answer: '0' };
const trade = (p: Partial<Trade>): Trade => ({ tx: '0x', block: 1, time: 1, account: '0x', tokenIn: Q, tokenOut: S, amountIn: '0', amountOut: '0', priceUsdAtTrade: 0, venuePriceUsd: 0, oracle, modelHash: '0x', ...p });

// Buy 100 USD of stock at 10 USD (10 units), oracle said 12 at that time.
const buy = trade({ amountIn: '100000000', amountOut: (10n * 10n ** 18n).toString(), priceUsdAtTrade: 12 });
// Sell 4 units for 60 USD (15 each), oracle said 14 at that time.
const sell = trade({ tokenIn: S, tokenOut: Q, amountIn: (4n * 10n ** 18n).toString(), amountOut: '60000000', priceUsdAtTrade: 14 });

describe('pnl math', () => {
  it('legs carry the sign of the account cash flow', () => {
    assert.deepEqual(legs(buy, TOKENS), { quote: -100, stock: 10 });
    assert.deepEqual(legs(sell, TOKENS), { quote: 60, stock: -4 });
  });

  it('values a buy at the mark', () => {
    const s = summarize([buy], TOKENS, 12);
    assert.equal(s.pnlUsd, 20); // 10 units * 12 - 100
    assert.equal(s.returnPct, 20);
    assert.equal(s.deployedUsd, 100);
    assert.equal(s.pnlAtTradeUsd, 20); // 10 * 12 - 100
  });

  it('a sell realizes cash and shrinks the position', () => {
    const s = summarize([buy, sell], TOKENS, 12);
    assert.equal(s.pnlUsd, -100 + 60 + 6 * 12); // 32
    assert.equal(s.returnPct, 32);
    assert.equal(s.pnlAtTradeUsd, (-100 + 10 * 12) + (60 - 4 * 14)); // 20 + 4
  });

  it('prices each trade with its own oracle round, not the latest', () => {
    const early = trade({ ...buy, priceUsdAtTrade: 11 });
    const late = trade({ ...buy, priceUsdAtTrade: 13 });
    assert.equal(summarize([early, late], TOKENS, 99).pnlAtTradeUsd, (10 * 11 - 100) + (10 * 13 - 100));
  });

  it('venue price is quote paid per stock unit', () => {
    assert.equal(venuePrice(buy, TOKENS), 10);
    assert.equal(venuePrice(sell, TOKENS), 15);
  });

  it('refuses a pair that is not quote against stock, and unknown tokens', () => {
    assert.throws(() => legs(trade({ tokenOut: Q }), TOKENS));
    assert.throws(() => legs(trade({ tokenOut: '0x0000000000000000000000000000000000000001' }), TOKENS));
  });

  it('no trades means zero return, not NaN', () => {
    assert.deepEqual(summarize([], TOKENS, 12), { pnlUsd: 0, pnlAtTradeUsd: 0, deployedUsd: 0, returnPct: 0 });
  });
});

describe('committed web/lib/track-record.json', () => {
  const tr = JSON.parse(readFileSync(new URL('../../web/lib/track-record.json', import.meta.url), 'utf8')) as TrackRecord;
  const TESTNET_TOKENS: Record<string, TokenInfo> = {
    '0x3500daf0adce615a0bef108ff0751abb34b1ffcc': { decimals: 6, kind: 'quote' },
    '0x7e955252e15c84f5768b83c41a71f9eba181802f': { decimals: 6, kind: 'quote' },
    '0xc9f9c86933092bbbfff3ccb4b105a4a94bf3bd4e': { decimals: 18, kind: 'stock' },
  };

  it('is non-empty and each agent recomputes from its own trades', () => {
    assert.ok(tr.agents.length >= 1);
    for (const a of tr.agents) {
      assert.ok(a.trades.length >= 1);
      assert.equal(a.tradeCount, a.trades.length);
      const s = summarize(a.trades, TESTNET_TOKENS, tr.pricing.mark.priceUsd);
      assert.ok(Math.abs(s.pnlUsd - a.pnlUsd) < 1e-9, `${a.measurement} pnl ${s.pnlUsd} vs ${a.pnlUsd}`);
      assert.ok(Math.abs(s.returnPct - a.returnPct) < 1e-9);
      for (const t of a.trades) {
        assert.equal(t.modelHash, a.modelHash);
        assert.ok(t.oracle.updatedAt <= t.time, 'the oracle round used is not from after the trade');
        assert.equal(t.priceUsdAtTrade, Number(t.oracle.answer) / 1e8);
      }
    }
  });

  it('selects by measurement, case-insensitive, and reports a miss', () => {
    const m = tr.agents[0].measurement;
    const hit = selectTrackRecord(tr, m.toUpperCase().replace('0X', '0x')) as { found: boolean; agents: { trades: unknown[] }[] };
    assert.equal(hit.found, true);
    assert.equal(hit.agents.length >= 1, true);
    assert.ok(hit.agents[0].trades.length >= 1);
    const miss = selectTrackRecord(tr, `0x${'ab'.repeat(32)}`) as { found: boolean; agents: unknown[] };
    assert.equal(miss.found, false);
    assert.equal(miss.agents.length, 0);
  });
});
