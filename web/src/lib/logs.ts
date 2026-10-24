/** The Robinhood Chain RPC refuses an eth_getLogs span above 10,000,000 blocks. */
export const LOG_SPAN = 9_000_000n;

/** Split [from, to] into consecutive windows of at most `span` blocks. */
export function windows(from: bigint, to: bigint, span: bigint = LOG_SPAN): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += span) out.push([a, a + span - 1n < to ? a + span - 1n : to]);
  return out;
}

/** Run `get` over every window of [from, to] and concatenate the results in block order. */
export async function inWindows<T>(from: bigint, to: bigint, get: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>): Promise<T[]> {
  return (await Promise.all(windows(from, to).map(([a, b]) => get(a, b)))).flat();
}
