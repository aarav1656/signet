// Client for the Phala Confidential AI gateway this repo already documents
// (README.md): POST /v1/chat/completions for a
// completion, then GET /v1/signature/{chat_id} for the enclave's legacy
// personal_sign receipt over "<requestHash>:<responseHash>" (sha256, per
// Dstack-TEE/private-ai-gateway's legacy_signature_text / body_hash).
import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { phalaApiKey, phalaBaseUrl, phalaModel } from './config.ts';

export type CompletionResult = {
  chatId: string;
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

function sha256Hex(bytes: Uint8Array): string {
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
  return { chatId: parsed.id, requestBody, responseBody };
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
