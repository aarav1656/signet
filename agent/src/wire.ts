// JSON wire format between the operator machine and the CVM control route: viem arguments carry
// bigints, which JSON cannot, so they travel as {"$bigint":"<decimal>"}.
export function toWire(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $bigint: x.toString() } : x));
}

export function fromWire<T>(s: string): T {
  return JSON.parse(s, (_k, x) =>
    x !== null && typeof x === 'object' && Object.keys(x).length === 1 && typeof (x as { $bigint?: unknown }).$bigint === 'string'
      ? BigInt((x as { $bigint: string }).$bigint)
      : x,
  ) as T;
}
