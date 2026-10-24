// The decision loop that runs inside the CVM. Each cycle the agent reads the market (pool quote,
// account balances), applies the strategy's rules, asks the pinned model through the receipt path
// (inferenceReceipt: a Phala receipt verified here and again on chain by the account), reads the
// answer, and submits `execute` itself with its in-memory key. Nothing outside the CVM supplies a
// trade: there is no route that takes one.
import type { Address, Hex } from 'viem';
import {
  balances,
  executedLog,
  inferenceReceipt,
  market,
  quoteMinOut,
  quoterOut,
  read,
  readPin,
  type AgentCtx,
  type Executed,
} from './account.ts';
import { parseDecision, renderPrompt, type Strategy } from './strategy.ts';

export type CycleResult =
  | { action: 'skip'; reason: string }
  | { action: 'hold'; reason: string }
  | { action: 'trade'; hash: Hex; tradeId: bigint; amountIn: bigint; amountOut: bigint };

export type CycleDeps = {
  inference: typeof inferenceReceipt;
  now: () => number;
};

const realDeps: CycleDeps = { inference: inferenceReceipt, now: () => Math.floor(Date.now() / 1000) };

/// Timestamps (seconds) of trades this process submitted in the last 24 h. The account's own
/// rolling caps are the real limit; this keeps a restart-free run inside the strategy's own.
export type TradeLog = number[];

export async function runCycle(ctx: AgentCtx, s: Strategy, tradeLog: TradeLog, deps: CycleDeps = realDeps): Promise<CycleResult> {
  const now = deps.now();
  while (tradeLog.length > 0 && tradeLog[0] <= now - 86_400) tradeLog.shift();
  if (tradeLog.length >= s.parameters.maxTradesPerDay) return { action: 'skip', reason: 'maxTradesPerDay reached' };

  const [agent, expiry, paused] = await Promise.all([read<Address>(ctx, 'agent'), read<bigint>(ctx, 'agentExpiry'), read<boolean>(ctx, 'paused')]);
  if (agent.toLowerCase() !== ctx.agent.address.toLowerCase()) return { action: 'skip', reason: `account agent() is not this key; the owner has not registered it` };
  if (BigInt(now) + 60n >= expiry) return { action: 'skip', reason: 'agent registration expired or about to; waiting for the keeper to renew it' };
  if (paused) return { action: 'skip', reason: 'account is paused' };

  const m = await market(ctx);
  if (s.parameters.amountIn > m.approvalAbove) return { action: 'skip', reason: `strategy amountIn ${s.parameters.amountIn} is above the account's approvalAbove ${m.approvalAbove}` };
  const draft = m.buy(s.parameters.amountIn);
  const [bal, quoteOut] = await Promise.all([balances(ctx, m.usdg), quoterOut(ctx, draft)]);
  if (quoteOut < s.rules.minQuoteOut) return { action: 'hold', reason: `quote ${quoteOut} is below rules.minQuoteOut ${s.rules.minQuoteOut}; model not asked` };

  const prompt = renderPrompt(s, { amountIn: s.parameters.amountIn, quoteOut, usdgBalance: bal.usdg, tslaBalance: bal.tsla });
  const pin = await readPin(ctx);
  const { receipt, served, answer } = await deps.inference(ctx, pin, prompt, { logAnswer: false });
  if (parseDecision(s, answer) !== 'buy') return { action: 'hold', reason: 'model did not answer with the buy word' };

  const t = { ...draft, minOut: await quoteMinOut(ctx, draft, receipt, s.parameters.slippageBps) };
  const hash = await ctx.agent.write({ functionName: 'execute', args: [t, receipt] });
  tradeLog.push(now);
  const { log } = await executedLog(ctx, hash);
  assertLog(log, served, s.parameters.amountIn);
  return { action: 'trade', hash, tradeId: log.tradeId, amountIn: log.amountIn, amountOut: log.amountOut };
}

function assertLog(log: Executed, served: Hex, amountIn: bigint) {
  if (log.servedModelHash !== served) throw new Error(`TradeExecuted servedModelHash ${log.servedModelHash} != the receipt's ${served}`);
  if (log.amountIn > amountIn) throw new Error(`TradeExecuted spent ${log.amountIn}, more than the strategy's ${amountIn}`);
}

/// Runs cycles forever, one at a time, `intervalSeconds` apart. A failed cycle is logged and the
/// next one still runs. Returns a stop function.
export function startLoop(ctx: AgentCtx, s: Strategy, log: (line: string) => void = console.log): () => void {
  const tradeLog: TradeLog = [];
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      const r = await runCycle(ctx, s, tradeLog);
      log(r.action === 'trade' ? `cycle trade: tx ${r.hash} tradeId ${r.tradeId} spent ${r.amountIn} got ${r.amountOut}` : `cycle ${r.action}: ${r.reason}`);
    } catch (e) {
      log(`cycle failed: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`);
    }
    if (!stopped) timer = setTimeout(tick, s.parameters.intervalSeconds * 1000);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
