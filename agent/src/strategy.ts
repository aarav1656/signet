// The private strategy the CVM runs. The strategy text arrives as sealed (encrypted) config, so
// the operator and the public never read it. dstack encrypted env is not authenticated: anyone
// with VMM access can encrypt a different payload to the app's public key (dstack
// docs/encrypted-env-spec.md, docs/security/security-best-practices.md). So the CVM computes the
// SHA-256 of the exact bytes at boot and refuses to start unless it equals STRATEGY_SHA256, a
// literal in the compose file. The compose file is measured (RTMR3 compose-hash), so the
// measurement commits to this digest while the text stays private.
import { createHash } from 'node:crypto';

export type Strategy = {
  version: 1;
  /// Sent to the pinned model. Placeholders: {amountIn} {quoteOut} {usdgBalance} {tslaBalance}.
  prompt: string;
  parameters: {
    /// Raw units of the account's quote token spent per trade.
    amountIn: bigint;
    slippageBps: number;
    intervalSeconds: number;
    maxTradesPerDay: number;
  };
  rules: {
    /// The first word of the answer that means trade. Any other answer is a hold.
    buyReply: string;
    /// Stand aside without asking the model when the quoter returns less than this for amountIn.
    minQuoteOut: bigint;
  };
};

export type Decision = 'buy' | 'hold';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function uint(v: unknown, name: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new Error(`strategy ${name} must be an integer in [0, ${max}]`);
  return v;
}

function rawAmount(v: unknown, name: string): bigint {
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) throw new Error(`strategy ${name} must be a decimal string of raw units`);
  return BigInt(v);
}

function word(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^[A-Za-z]{1,16}$/.test(v)) throw new Error(`strategy ${name} must be one word of letters`);
  return v.toUpperCase();
}

/// Parses and validates the strategy file. Messages name the field, never the content: the
/// strategy is private and must not reach the CVM logs.
export function parseStrategy(bytes: Uint8Array): Strategy {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('strategy is not valid UTF-8 JSON');
  }
  if (!isObject(raw) || raw.version !== 1) throw new Error('strategy version must be 1');
  if (typeof raw.prompt !== 'string' || raw.prompt.trim() === '') throw new Error('strategy prompt must be a non-empty string');
  const p = raw.parameters;
  const r = raw.rules;
  if (!isObject(p) || !isObject(r)) throw new Error('strategy needs parameters and rules objects');
  const strategy: Strategy = {
    version: 1,
    prompt: raw.prompt,
    parameters: {
      amountIn: rawAmount(p.amountIn, 'parameters.amountIn'),
      slippageBps: uint(p.slippageBps, 'parameters.slippageBps', 5_000),
      intervalSeconds: uint(p.intervalSeconds, 'parameters.intervalSeconds', 86_400),
      maxTradesPerDay: uint(p.maxTradesPerDay, 'parameters.maxTradesPerDay', 10_000),
    },
    rules: { buyReply: word(r.buyReply, 'rules.buyReply'), minQuoteOut: rawAmount(r.minQuoteOut, 'rules.minQuoteOut') },
  };
  if (strategy.parameters.amountIn === 0n) throw new Error('strategy parameters.amountIn must be positive');
  if (strategy.parameters.intervalSeconds < 10) throw new Error('strategy parameters.intervalSeconds must be at least 10');
  return strategy;
}

/// The boot check. Throws unless sha256(bytes) equals the digest pinned in the compose file.
export function loadStrategy(bytes: Uint8Array, pinnedSha256: string): { strategy: Strategy; sha256: string } {
  const pinned = pinnedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pinned)) throw new Error('STRATEGY_SHA256 must be 64 hex characters');
  const got = sha256Hex(bytes);
  if (got !== pinned) throw new Error(`STRATEGY_SHA256 mismatch: the sealed strategy hashes to ${got}, the compose file pins ${pinned}`);
  return { strategy: parseStrategy(bytes), sha256: got };
}

export type Market = { amountIn: bigint; quoteOut: bigint; usdgBalance: bigint; tslaBalance: bigint };

export function renderPrompt(s: Strategy, m: Market): string {
  return s.prompt
    .replaceAll('{amountIn}', m.amountIn.toString())
    .replaceAll('{quoteOut}', m.quoteOut.toString())
    .replaceAll('{usdgBalance}', m.usdgBalance.toString())
    .replaceAll('{tslaBalance}', m.tslaBalance.toString());
}

/// Anything that is not exactly the buy word is a hold: an unparseable answer never trades.
export function parseDecision(s: Strategy, answer: string): Decision {
  const first = answer.trim().split(/[^A-Za-z]+/).find((w) => w !== '');
  return first !== undefined && first.toUpperCase() === s.rules.buyReply ? 'buy' : 'hold';
}
