import { encodeAbiParameters, hexToBytes, keccak256, toBytes, type Hex } from 'viem';

/** keccak256 of a model id string, as the account pins it (abi.encodePacked(string)). */
export const modelHash = (id: string): Hex => keccak256(toBytes(id));

/** The account's replay key: keccak256(abi.encode(requestHash, responseHash)), see AgentAccount._consumeReceipt. */
export const receiptKey = (requestHash: Hex, responseHash: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [requestHash, responseHash]));

export type ParsedReceipt = { requested: Hex; served: Hex; requestHash: Hex; responseHash: Hex };

type Ev = { type?: string; model_id?: string; result?: string; body_hash?: string };

const bodyHash = (events: Ev[], type: string): Hex | undefined => {
  const h = events.find((e) => e.type === type)?.body_hash;
  return h && /^sha256:[0-9a-f]{64}$/.test(h) ? (`0x${h.slice(7)}` as Hex) : undefined;
};

/** The four values receipt-verifier returns on chain, read from the receipt's own JSON bytes. */
export function parseReceipt(receiptBytes: Hex): ParsedReceipt | undefined {
  try {
    const doc = JSON.parse(new TextDecoder().decode(hexToBytes(receiptBytes))) as { model?: string; event_log?: Ev[] };
    const ev = doc.event_log ?? [];
    const served = ev.find((e) => e.type === 'upstream.verified' && e.result === 'verified')?.model_id;
    const requestHash = bodyHash(ev, 'request.received');
    const responseHash = bodyHash(ev, 'response.returned');
    if (!doc.model || !served || !requestHash || !responseHash) return undefined;
    return { requested: modelHash(doc.model), served: modelHash(served), requestHash, responseHash };
  } catch {
    return undefined;
  }
}

export type Check = { name: string; ok: boolean; detail: string };

export type ReceiptFacts = {
  /** What the chain recorded in the event. */
  recorded: { requestHash: Hex; responseHash: Hex; served: Hex };
  /** Receipt bytes from the calldata, when the tx carries them. */
  receiptBytes?: Hex;
  /** The account's model pin and replay record. */
  pin: { requested: Hex; accepted: Hex[] };
  consumed: boolean;
  /** Caller-supplied served model hash to compare against. */
  expectedServed?: Hex;
};

const eq = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** Every check, none assumed. verified is true only when the list is non-empty and all pass. */
export function checkReceipt(f: ReceiptFacts): { verified: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const key = receiptKey(f.recorded.requestHash, f.recorded.responseHash);
  add('receipt_consumed', f.consumed, `account.usedReceipt(${key}) is ${f.consumed}`);
  const accepted = f.recorded.served !== `0x${'0'.repeat(64)}` && f.pin.accepted.some((a) => eq(a, f.recorded.served));
  add('served_model_pinned', accepted, `recorded served model ${f.recorded.served} ${accepted ? 'is' : 'is not'} in the account's accepted set`);
  if (f.receiptBytes) {
    const p = parseReceipt(f.receiptBytes);
    add('receipt_parses', !!p, p ? 'receipt JSON carries model, upstream.verified and both body hashes' : 'receipt bytes do not parse');
    if (p) {
      add('receipt_hash_matches', eq(receiptKey(p.requestHash, p.responseHash), key), `recomputed key from receipt bytes ${receiptKey(p.requestHash, p.responseHash)} vs recorded ${key}`);
      add('requested_model_matches_pin', eq(p.requested, f.pin.requested), `receipt model hash ${p.requested} vs pin ${f.pin.requested}`);
      add('served_model_matches_receipt', eq(p.served, f.recorded.served), `receipt served hash ${p.served} vs recorded ${f.recorded.served}`);
    }
  }
  if (f.expectedServed) add('served_model_equals_expected', eq(f.expectedServed, f.recorded.served), `expected ${f.expectedServed} vs recorded ${f.recorded.served}`);
  return { verified: checks.length > 0 && checks.every((c) => c.ok), checks };
}
