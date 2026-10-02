import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import handler from '../api/mcp.js';

// Same real trade as verify.test.ts, reached the way a remote agent reaches it: MCP over HTTP.
// MCP_URL points the test at the deployed endpoint instead of a local listener.
const TRADE = '0xe50522661b55c797071b56e43aaf2bc91d37c9745a295ff6a5976883dd4ddfa2';
const SERVED = '0xc8536dbf086093b9b12c84bc9c4448f0c36c74d9b4a65cda6667d9d99f78df59';

let http: Server | undefined;
let url = process.env.MCP_URL ?? '';

async function call(name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'chiron-http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  try {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as { text: string }[])[0].text);
  } finally {
    await client.close();
  }
}

before(async () => {
  if (url) return;
  http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    await handler(Object.assign(req, { body: raw ? JSON.parse(raw) : undefined }), res);
  });
  await new Promise<void>((r) => http!.listen(0, r));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}/api/mcp`;
});
after(() => http?.close());

describe('MCP over Streamable HTTP', () => {
  it('lists the three tools', async () => {
    const client = new Client({ name: 'chiron-http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const { tools } = await client.listTools();
    await client.close();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['account_state', 'explain_refusal', 'verify_receipt']);
  });

  it('verifies the real trade', async () => {
    const r = await call('verify_receipt', { tx_hash: TRADE, expected_served_model_hash: SERVED });
    assert.ok(r.checks.length >= 6);
    assert.equal(r.verified, true);
  });

  it('refuses the same trade against a different model hash', async () => {
    const r = await call('verify_receipt', { tx_hash: TRADE, expected_served_model_hash: `0x${'11'.repeat(32)}` });
    assert.equal(r.verified, false);
  });
});
