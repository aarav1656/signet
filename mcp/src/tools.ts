import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { accountState, explainRefusal, rhcClient, verifyReceipt } from './chain.js';

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte hex transaction hash');
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte hex address');
const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

/** The three Chiron tools on one server; stdio (server.ts) and Streamable HTTP (api/mcp.ts) both serve it. */
export function buildServer(rpcUrl?: string): McpServer {
  const c = rhcClient(rpcUrl);
  const server = new McpServer({ name: 'chiron', version: '0.1.0' });
  server.registerTool(
    'verify_receipt',
    {
      description: 'Verify a Chiron trade on Robinhood Chain testnet (46630). Recomputes the receipt hash from chain data, checks the recorded model hash against the account model pin. verified is false unless every check passes.',
      inputSchema: { tx_hash: hash, expected_served_model_hash: hash.optional() },
    },
    async ({ tx_hash, expected_served_model_hash }) => json(await verifyReceipt(c, tx_hash as `0x${string}`, { expectedServed: expected_served_model_hash as `0x${string}` | undefined })),
  );

  server.registerTool(
    'account_state',
    { description: 'Read a Chiron AgentAccount: agent, measurement, expiry, caps and recent trades.', inputSchema: { account: addr } },
    async ({ account }) => json(await accountState(c, account as `0x${string}`)),
  );

  server.registerTool(
    'explain_refusal',
    { description: 'Explain in plain words why a reverted Chiron account transaction was refused (decodes the custom error).', inputSchema: { tx_hash: hash } },
    async ({ tx_hash }) => json(await explainRefusal(c, tx_hash as `0x${string}`)),
  );
  return server;
}
