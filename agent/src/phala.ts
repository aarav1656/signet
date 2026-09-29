// Client for the Phala Confidential AI gateway this repo already documents
// (README.md): POST /v1/chat/completions for a
// completion, then GET /v1/signature/{chat_id} for the enclave's legacy
// personal_sign receipt over "<requestHash>:<responseHash>" (sha256, per
// Dstack-TEE/private-ai-gateway's legacy_signature_text / body_hash).
//
// Also: the newer Phala canonical ACI receipt path (Dstack-TEE/private-ai-gateway
// @ fea9d0ed37b1807edb418f2a8c2b4151c6d1fdb0, spec/aci.md) that
// receipt-verifier/'s IReceiptVerifier.verifyReceipt checks onchain --
// GET /v1/aci/attestation?nonce=... (resolves a receipt's key_id to the Ed25519
// pubkey that signed it, spec/aci.md keyset shape) and GET /v1/aci/receipts/{id}
// (the signed receipt document, credential-bound: same bearer key as the
// original request). This client does the identical local check before ever
// signing a voucher (see verifyReceiptLocally below); the onchain call in
// redeemWithReceipt() is the actual proof, this is a pre-flight refusal so the
// agent never pays gas on a receipt it already knows will fail.
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, type Hex } from 'viem';
import { phalaApiKey, phalaBaseUrl, phalaMaxTokens, phalaModel } from './config.ts';
import { modelHash } from './digest.ts';

export type CompletionResult = {
  chatId: string;
  /// spec/aci.md: the receipt id is the `X-Receipt-Id` response header when
  /// present (preferred), else the completion body's own `id` field (fallback,
  /// same value chatId already holds for this gateway).
  receiptId: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
};

export type SignatureResult = {
  text: string;
  signature: Hex;
  signingAddress: Hex;
  signingAlgo: string;
  requestHash: Hex;
  responseHash: Hex;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Security review point: a unique nonce per request body so a genuinely
// attested but cached response can't be replayed as if it were this call.
export async function requestCompletion(prompt: string, nonce: string): Promise<CompletionResult> {
  const key = phalaApiKey();
  if (!key) throw new Error('PHALA_API_KEY is not set');
  const bodyObj = {
    model: phalaModel,
    messages: [{ role: 'user', content: `${prompt}\n\n[nonce:${nonce}]` }],
    // The receipt, not the answer, is what gets paid for; keep each call's credit cost small.
    max_tokens: phalaMaxTokens,
  };
  const requestBody = new TextEncoder().encode(JSON.stringify(bodyObj));
  const res = await fetch(`${phalaBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: requestBody,
  });
  const responseBody = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`Phala completion failed: HTTP ${res.status} ${new TextDecoder().decode(responseBody)}`);
  }
  const parsed = JSON.parse(new TextDecoder().decode(responseBody)) as { id?: string };
  if (!parsed.id) throw new Error('Phala completion response has no id (chat_id)');
  const receiptId = res.headers.get('x-receipt-id') ?? parsed.id;
  return { chatId: parsed.id, receiptId, requestBody, responseBody };
}

// Security review points: ecdsa (ed25519 can never recover onchain), then the
// caller cross-checks sha256 of its own exact request/response bytes against
// the hashes embedded in this receipt's text before trusting it.
export async function fetchSignature(chatId: string): Promise<SignatureResult> {
  const key = phalaApiKey();
  if (!key) throw new Error('PHALA_API_KEY is not set');
  const url = `${phalaBaseUrl}/v1/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) {
    throw new Error(`Phala signature fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    text: string;
    signature: string;
    signing_address: string;
    signing_algo: string;
  };
  const parts = body.text.split(':');
  if (parts.length !== 2 || parts[0].length !== 64 || parts[1].length !== 64) {
    throw new Error(`Phala receipt text is not in the expected "<hex64>:<hex64>" format: ${body.text}`);
  }
  return {
    text: body.text,
    signature: (body.signature.startsWith('0x') ? body.signature : `0x${body.signature}`) as Hex,
    signingAddress: (body.signing_address.startsWith('0x') ? body.signing_address : `0x${body.signing_address}`) as Hex,
    signingAlgo: body.signing_algo,
    requestHash: `0x${parts[0]}` as Hex,
    responseHash: `0x${parts[1]}` as Hex,
  };
}

// Provenance guard (per the security review): the receipt's embedded hashes must
// equal sha256 of the exact bytes we sent and received, not just parse cleanly.
export function verifyBodyHashes(completion: CompletionResult, sig: SignatureResult): { requestOk: boolean; responseOk: boolean } {
  const requestOk = sha256Hex(completion.requestBody) === sig.requestHash.slice(2);
  const responseOk = sha256Hex(completion.responseBody) === sig.responseHash.slice(2);
  return { requestOk, responseOk };
}

// ---------------------------------------------------------------------------
// Phala canonical ACI receipts (spec/aci.md, Dstack-TEE/private-ai-gateway
// @ fea9d0ed37b1807edb418f2a8c2b4151c6d1fdb0). Fetched, JCS-canonicalized and
// Ed25519-verified entirely client-side, using the exact same bytes
// IReceiptVerifier.verifyReceipt hashes onchain (cross-checked against
// fixtures/receipt_vectors.json in receipt.test.ts).

export type ReceiptSigningKey = { keyId: string; algo: string; publicKeyHex: string };

export type AttestationResult = {
  workloadKeysetDigest: string;
  receiptSigningKeys: ReceiptSigningKey[];
  /// TDX quote whose report_data commits to sha256 of the JCS statement
  /// {keyset_digest, nonce, purpose}; what Assay.registerReceiptKey verifies.
  quote: Hex;
  /// JCS bytes of attestation.workload_keyset: the preimage of keyset_digest.
  keysetBytes: Uint8Array;
};

/// spec/aci.md: `GET /v1/aci/attestation?nonce=<fresh-client-nonce>`. No
/// PHALA_API_KEY required -- this endpoint establishes the keyset, it does not
/// gate on the caller's own prior request the way /v1/aci/receipts/{id} does.
export async function fetchAttestation(nonce: string): Promise<AttestationResult> {
  const url = `${phalaBaseUrl}/v1/aci/attestation?nonce=${encodeURIComponent(nonce)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Phala ACI attestation fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    workload_keyset_digest: string;
    attestation: {
      workload_keyset: { receipt_signing_keys: { key_id: string; algo: string; public_key: string }[] };
      evidence: { quote: string };
    };
  };
  const receiptSigningKeys = body.attestation.workload_keyset.receipt_signing_keys.map((k) => ({
    keyId: k.key_id,
    algo: k.algo,
    publicKeyHex: k.public_key,
  }));
  const keysetBytes = new TextEncoder().encode(canonicalizeValue(body.attestation.workload_keyset));
  const expectedDigest = `sha256:${sha256Hex(keysetBytes)}`;
  if (expectedDigest !== body.workload_keyset_digest) {
    throw new Error(`canonicalized keyset hashes to ${expectedDigest}, response says ${body.workload_keyset_digest}`);
  }
  const q = body.attestation.evidence.quote;
  return {
    workloadKeysetDigest: body.workload_keyset_digest,
    receiptSigningKeys,
    quote: (q.startsWith('0x') ? q : `0x${q}`) as Hex,
    keysetBytes,
  };
}

/// Legacy `GET /v1/attestation/report?nonce=<hex64>`: the TDX quote whose
/// report_data is signing_address(20) || zero(12) || nonce(32), what
/// Assay.register verifies. No API key needed.
export async function fetchLegacyReport(nonceHex: string): Promise<{ quote: Hex; signingAddress: Hex }> {
  const url = `${phalaBaseUrl}/v1/attestation/report?nonce=${encodeURIComponent(nonceHex)}&signing_algo=ecdsa`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Phala legacy attestation fetch failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { intel_quote: string; signing_address: string };
  const q = body.intel_quote;
  return { quote: (q.startsWith('0x') ? q : `0x${q}`) as Hex, signingAddress: body.signing_address as Hex };
}

export function resolveReceiptKey(attestation: AttestationResult, keyId: string): ReceiptSigningKey {
  const key = attestation.receiptSigningKeys.find((k) => k.keyId === keyId);
  if (!key) throw new Error(`ACI receipt key_id "${keyId}" is not in the established keyset's receipt_signing_keys`);
  if (key.algo !== 'ed25519') throw new Error(`ACI receipt key_id "${keyId}" has algo "${key.algo}", expected ed25519`);
  return key;
}

/// spec/aci.md receipt document shape (this client's own view of the fields
/// verifyReceiptLocally needs; the served document may carry more).
export type ReceiptDocument = {
  api_version: string;
  receipt_id: string;
  chat_id: string;
  model: string;
  workload_keyset_digest: string;
  endpoint: string;
  method: string;
  served_at: number;
  event_log: Array<Record<string, unknown> & { type: string }>;
  key_id: string;
  signature: string;
};

/// spec/aci.md: `GET /v1/aci/receipts/{id}`, credential-bound to the same
/// bearer key used for the original completion request.
export async function fetchReceipt(receiptId: string): Promise<ReceiptDocument> {
  const key = phalaApiKey();
  if (!key) throw new Error('PHALA_API_KEY is not set');
  const res = await fetch(`${phalaBaseUrl}/v1/aci/receipts/${encodeURIComponent(receiptId)}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`Phala ACI receipt fetch failed: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ReceiptDocument;
}

/// Minimal JCS (RFC 8785) canonicalizer: sorted object keys, compact
/// separators, integers only. Sufficient for this one document type --
/// receipt-verifier's own README states every member is ASCII and every
/// number an integer, so full RFC 8785 float/UTF-16 handling is unneeded here
/// (ponytail: narrower canonicalizer, full RFC 8785 lib if a future document
/// type in this gateway ever carries a float or non-ASCII string).
function canonicalizeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`canonicalizeValue: non-integer ${value} unsupported by this narrow JCS canonicalizer`);
    return String(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeValue).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeValue(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalizeValue: unsupported type ${typeof value}`);
}

/// The exact bytes IReceiptVerifier.verifyReceipt signs/verifies over: the
/// receipt document's JCS form with its own `signature` member removed
/// (aci_protocol::receipt::receipt_signing_input's output, per
/// IReceiptVerifier.sol's own doc comment).
export function receiptSigningInput(doc: ReceiptDocument): Uint8Array {
  const { signature: _signature, ...rest } = doc;
  return new TextEncoder().encode(canonicalizeValue(rest));
}

export type LocalReceiptCheck = {
  ok: boolean;
  requestedModel: string;
  servedModel?: string;
  /// Raw hex (no `0x`) of the response.returned event's body_hash digest,
  /// after its "sha256:" prefix is stripped -- the same 32 bytes
  /// IReceiptVerifier.verifyReceipt returns as `responseHash`, not a re-hash.
  responseHashHex?: string;
  reason?: string;
};

/// Local, pre-flight equivalent of what IReceiptVerifier.verifyReceipt proves
/// onchain: Ed25519 signature over the JCS signing input verifies under the
/// attested `key_id`'s pubkey, `upstream.verified` says the aggregator itself
/// confirmed the served model, and both requested/served model plus the
/// response body hash are extracted so the caller can refuse a swap before
/// ever signing a voucher. Never trusts the served document's own byte order --
/// canonicalizes independently, per spec/aci.md's "any JSON encoding of the
/// same document verifies, client MUST canonicalize itself" (client
/// verification procedure section 9.3, steps 1-4; this covers steps 1-2 and
/// the model/response extraction, steps 3-4 body-hash-vs-sent-bytes are the
/// caller's job since only it knows the exact request/response bytes it sent).
export function verifyReceiptLocally(doc: ReceiptDocument, pubkeyHex: string): LocalReceiptCheck {
  const signingInput = receiptSigningInput(doc);
  const sigHex = (doc.signature.startsWith('0x') ? doc.signature.slice(2) : doc.signature) as Hex;
  const pkHex = (pubkeyHex.startsWith('0x') ? pubkeyHex.slice(2) : pubkeyHex) as Hex;
  let sigOk: boolean;
  try {
    sigOk = ed25519.verify(hexToBytes(`0x${sigHex}`), signingInput, hexToBytes(`0x${pkHex}`));
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, requestedModel: doc.model, reason: 'ed25519 signature over the JCS signing input does not verify under key_id\'s pubkey' };
  }

  const upstream = doc.event_log.find((e) => e.type === 'upstream.verified');
  const responseReturned = doc.event_log.find((e) => e.type === 'response.returned');
  if (!upstream || upstream.result !== 'verified') {
    return {
      ok: false,
      requestedModel: doc.model,
      reason: `upstream.verified missing or not "verified" (got ${upstream ? JSON.stringify(upstream.result) : 'no upstream.verified event'})`,
    };
  }
  const servedModel = upstream.model_id as string | undefined;
  const bodyHashField = responseReturned?.body_hash as string | undefined;
  if (!servedModel || !bodyHashField) {
    return { ok: false, requestedModel: doc.model, servedModel, reason: 'receipt missing upstream.verified.model_id or response.returned.body_hash' };
  }
  const responseHashHex = bodyHashField.startsWith('sha256:') ? bodyHashField.slice('sha256:'.length) : bodyHashField;
  return { ok: true, requestedModel: doc.model, servedModel, responseHashHex };
}
