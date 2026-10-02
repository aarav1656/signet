// The attested agent, as it runs inside a Phala Cloud dstack CVM. The agent key is generated in
// memory at boot and never leaves this process. The owner key is never present. Routes:
//
//   GET  /info              the agent address, the default account, the chain id.
//   POST /quote?account=0x  a TDX quote whose report_data is agent(20) || 0(12) || attestNonce(32),
//                           with the nonce read from that account at head-1: exactly what its
//                           AgentAccount.registerAgent expects. registerAgent is permissionless, so
//                           the client or the operator submits it. One key, many client accounts.
//   POST /tx      sign and send one agent-side call (execute, propose, cancelProposal) on `account`
//                 (default ACCOUNT_ADDRESS) with the in-memory key. Bearer CONTROL_TOKEN. Each
//                 account's caps and receipt checks are the policy; this route only holds the key.
//
// /info and /quote answer cross-origin, so a client's browser can fetch a quote for its own account.
// ACCOUNT_ADDRESS and RHC_RPC_URL come from the compose file, so they are measured into RTMR3.
import { createServer, request, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentAccountAbi } from './account-abi.ts';
import { agentReportData, RHC_TESTNET_ID } from './account.ts';
import { fromWire, toWire } from './wire.ts';

const SOCKET = process.env.DSTACK_SOCKET ?? '/var/run/dstack.sock';
const AGENT_FUNCTIONS = new Set(['execute', 'propose', 'cancelProposal']);

function need(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

/// dstack guest agent: POST /GetQuote {report_data: hex} over its unix socket.
export function getQuote(reportDataHex: Hex, socketPath = SOCKET): Promise<Hex> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ report_data: reportDataHex.slice(2).toLowerCase() });
    const req = request(
      { socketPath, path: '/GetQuote', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { quote?: string; error?: string };
            if (res.statusCode !== 200 || !j.quote) throw new Error(`GetQuote HTTP ${res.statusCode}: ${j.error ?? 'no quote'}`);
            resolve((j.quote.startsWith('0x') ? j.quote : `0x${j.quote}`) as Hex);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function authorised(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' };

function reply(res: ServerResponse, status: number, body: unknown, cors = false) {
  res.writeHead(status, { 'content-type': 'application/json', ...(cors ? CORS : {}) });
  res.end(toWire(body));
}

/// `account` from the query string or the tx body, else the compose default. Undefined when malformed.
function pickAccount(raw: unknown, fallback: Address): Address | undefined {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return typeof raw === 'string' && isAddress(raw) ? getAddress(raw) : undefined;
}

async function main() {
  const rpc = need('RHC_RPC_URL');
  const account = need('ACCOUNT_ADDRESS') as Address;
  const token = need('CONTROL_TOKEN');
  const chain = defineChain({
    id: RHC_TESTNET_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const agent = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) });
  const chainId = await publicClient.getChainId();
  if (chainId !== RHC_TESTNET_ID) throw new Error(`RPC chain id ${chainId}, expected ${RHC_TESTNET_ID}`);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://cvm');
      if (req.method === 'OPTIONS' && (url.pathname === '/info' || url.pathname === '/quote')) {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/info') return reply(res, 200, { agent: agent.address, account, chainId }, true);
      if (req.method === 'POST' && url.pathname === '/quote') {
        const target = pickAccount(url.searchParams.get('account'), account);
        if (!target) return reply(res, 400, { error: 'account is not an address' }, true);
        const refBlock = (await publicClient.getBlockNumber()) - 1n;
        const nonce = (await publicClient.readContract({ address: target, abi: agentAccountAbi, functionName: 'attestNonce', args: [refBlock] })) as Hex;
        const quote = await getQuote(agentReportData(agent.address, nonce));
        return reply(res, 200, { agent: agent.address, account: target, refBlock, nonce, quote }, true);
      }
      if (req.method === 'POST' && url.pathname === '/tx') {
        if (!authorised(req.headers.authorization, token)) return reply(res, 401, { error: 'unauthorised' });
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const { functionName, args, gas, account: raw } = fromWire<{ functionName: string; args: unknown[]; gas?: bigint; account?: string }>(Buffer.concat(chunks).toString('utf8'));
        if (!AGENT_FUNCTIONS.has(functionName)) return reply(res, 400, { error: `${functionName} is not an agent function` });
        const target = pickAccount(raw, account);
        if (!target) return reply(res, 400, { error: 'account is not an address' });
        const hash = await wallet.writeContract({
          address: target,
          abi: agentAccountAbi,
          functionName: functionName as never,
          args: args as never,
          ...(gas ? { gas } : {}),
        });
        return reply(res, 200, { hash });
      }
      return reply(res, 404, { error: 'not found' });
    } catch (e) {
      return reply(res, 500, { error: e instanceof Error ? e.message.split('\n')[0] : 'error' });
    }
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`agent ${agent.address} serving account ${account} on :${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
