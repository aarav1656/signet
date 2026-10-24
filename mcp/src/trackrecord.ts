// Track record of attested agents: pure PnL math and the shape of web/lib/track-record.json.
// No chain access here. mcp/src/trackrecord-chain.ts builds the JSON, tools.ts and server.ts serve it.

export type Trade = {
  tx: string;
  block: number;
  time: number;
  account: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  /** USD per stock token from the mainnet Chainlink round named in `oracle`, at the trade's block time. */
  priceUsdAtTrade: number;
  /** USD of quote asset paid per stock token actually received (or per stock token sold). */
  venuePriceUsd: number;
  oracle: { roundId: string; updatedAt: number; answer: string };
  modelHash: string;
};

export type Refusal = {
  tx: string;
  block: number;
  time: number;
  account: string;
  reason: string;
  method: string;
  measurement: string | null;
};

export type AgentRecord = {
  measurement: string;
  modelHash: string;
  label: string;
  workload: string | null;
  accounts: string[];
  trades: Trade[];
  pnlUsd: number;
  returnPct: number;
  pnlAtTradeUsd: number;
  deployedUsd: number;
  tradeCount: number;
  firstTrade: number;
  lastTrade: number;
};

export type TrackRecord = {
  generatedAt: string;
  chainId: 46630;
  block: number;
  pricing: {
    feed: string;
    feedChainId: 4663;
    decimals: 8;
    mark: { roundId: string; updatedAt: number; priceUsd: number };
    quoteAssetsUsd: number;
    note: string;
  };
  agents: AgentRecord[];
  refusals: Refusal[];
};

export type TokenInfo = { decimals: number; kind: 'quote' | 'stock' };

const units = (raw: string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

/** Signed USD of the quote leg and signed stock units for one trade, from the account's point of view. */
export function legs(t: Pick<Trade, 'tokenIn' | 'tokenOut' | 'amountIn' | 'amountOut'>, tokens: Record<string, TokenInfo>) {
  const inT = tokens[t.tokenIn.toLowerCase()];
  const outT = tokens[t.tokenOut.toLowerCase()];
  if (!inT || !outT) throw new Error(`unknown token in trade ${t.tokenIn} -> ${t.tokenOut}`);
  if (inT.kind === outT.kind) throw new Error('a trade must have one quote leg and one stock leg');
  const a = units(t.amountIn, inT.decimals);
  const b = units(t.amountOut, outT.decimals);
  return inT.kind === 'quote' ? { quote: -a, stock: b } : { quote: b, stock: -a };
}

/** Execution price of a trade in quote USD per stock token. */
export function venuePrice(t: Pick<Trade, 'tokenIn' | 'tokenOut' | 'amountIn' | 'amountOut'>, tokens: Record<string, TokenInfo>) {
  const l = legs(t, tokens);
  return Math.abs(l.quote) / Math.abs(l.stock);
}

/**
 * pnlUsd: cash flows plus the net stock position valued at `markPrice` (latest Chainlink round).
 * pnlAtTradeUsd: each trade valued at the Chainlink price recorded on that trade.
 * returnPct: pnlUsd over the quote asset deployed in buys.
 */
export function summarize(trades: Trade[], tokens: Record<string, TokenInfo>, markPrice: number) {
  let cash = 0;
  let stock = 0;
  let deployed = 0;
  let atTrade = 0;
  for (const t of trades) {
    const l = legs(t, tokens);
    cash += l.quote;
    stock += l.stock;
    if (l.quote < 0) deployed += -l.quote;
    atTrade += l.quote + l.stock * t.priceUsdAtTrade;
  }
  const pnlUsd = cash + stock * markPrice;
  return { pnlUsd, pnlAtTradeUsd: atTrade, deployedUsd: deployed, returnPct: deployed > 0 ? (pnlUsd / deployed) * 100 : 0 };
}

/** get_track_record: one agent by measurement (0x + 64 hex, any case), or every agent when omitted. */
export function selectTrackRecord(tr: TrackRecord, measurement?: string) {
  if (!measurement) {
    return { generatedAt: tr.generatedAt, chainId: tr.chainId, block: tr.block, pricing: tr.pricing, agents: tr.agents.map(({ trades, ...a }) => ({ ...a, tradeTxs: trades.map((t) => t.tx) })), refusals: tr.refusals };
  }
  const m = measurement.toLowerCase();
  const agents = tr.agents.filter((a) => a.measurement.toLowerCase() === m);
  return {
    generatedAt: tr.generatedAt,
    chainId: tr.chainId,
    block: tr.block,
    pricing: tr.pricing,
    measurement,
    found: agents.length > 0,
    agents,
    refusals: tr.refusals.filter((r) => r.measurement?.toLowerCase() === m),
  };
}
