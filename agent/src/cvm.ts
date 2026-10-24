// The attested agent, as it runs inside a Phala Cloud dstack CVM. The agent key is generated in
// memory at boot and never leaves this process. The owner key is never present.
//
// Boot: the sealed strategy (STRATEGY_B64) is hashed and must equal STRATEGY_SHA256, a literal in
// the compose file; otherwise the process exits before it generates a key or opens a port. Then
// the decision loop (loop.ts) starts: this process reads the market, runs the strategy, gets the
// model's receipt and submits the trade itself. There is no route that takes a trade from outside.
//
//   GET  /info              the agent address, the default account, the chain id.
//   POST /quote?account=0x  a TDX quote whose report_data is agent(20) || 0(12) || attestNonce(32),
//                           with the nonce read from that account at head-1: exactly what its
//                           AgentAccount.registerAgent expects. registerAgent is permissionless, so
//                           the client or the operator submits it. One key, many client accounts.
//                           eventLog is the RTMR event log: replaying it reproduces the quote's RTMR3
//                           and shows compose-hash, so the pinned strategy digest can be checked.
//
// /info and /quote answer cross-origin, so a client's browser can fetch a quote for its own account.
// ACCOUNT_ADDRESS, RHC_RPC_URL, PHALA_MODEL, PHALA_BASE_URL and STRATEGY_SHA256 come from the
// compose file, so they are measured into RTMR3. STRATEGY_B64 and PHALA_API_KEY are sealed.
import { createServer, request, type ServerResponse } from 'node:http';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentAccountAbi } from './account-abi.ts';
import { agentReportData, RHC_CHAIN_ID } from './account.ts';
import { startLoop } from './loop.ts';
import { loadStrategy } from './strategy.ts';
import { toWire } from './wire.ts';

const SOCKET = process.env.DSTACK_SOCKET ?? '/var/run/dstack.sock';

function need(name: string): string {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

/// dstack guest agent: POST /GetQuote {report_data: hex} over its unix socket. Returns the quote and
/// the RTMR event log it was taken with, so a verifier can replay RTMR3 and read compose-hash.
export function getQuote(reportDataHex: Hex, socketPath = SOCKET): Promise<{ quote: Hex; eventLog: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ report_data: reportDataHex.slice(2).toLowerCase() });
    const req = request(
      { socketPath, path: '/GetQuote', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { quote?: string; event_log?: string; error?: string };
            if (res.statusCode !== 200 || !j.quote) throw new Error(`GetQuote HTTP ${res.statusCode}: ${j.error ?? 'no quote'}`);
            resolve({ quote: (j.quote.startsWith('0x') ? j.quote : `0x${j.quote}`) as Hex, eventLog: j.event_log ?? '' });
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
  const model = need('PHALA_MODEL');
  need('PHALA_BASE_URL');
  need('PHALA_API_KEY');
  const { strategy, sha256 } = loadStrategy(Buffer.from(need('STRATEGY_B64'), 'base64'), need('STRATEGY_SHA256'));
  console.log(`strategy sha256 ${sha256} matches the compose pin; model ${model}`);
  const chain = defineChain({
    id: RHC_CHAIN_ID,
    name: 'Robinhood Chain Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const agent = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account: agent, chain, transport: http(rpc) });
  const chainId = await publicClient.getChainId();
  if (chainId !== RHC_CHAIN_ID) throw new Error(`RPC chain id ${chainId}, expected ${RHC_CHAIN_ID}`);

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
        const { quote, eventLog } = await getQuote(agentReportData(agent.address, nonce));
        return reply(res, 200, { agent: agent.address, account: target, refBlock, nonce, quote, eventLog }, true);
      }
      return reply(res, 404, { error: 'not found' });
    } catch (e) {
      return reply(res, 500, { error: e instanceof Error ? e.message.split('\n')[0] : 'error' });
    }
  });
  const port = Number(process.env.PORT ?? 8080);
  server.listen(port, () => console.log(`agent ${agent.address} serving account ${account} on :${port}`));
  startLoop(
    {
      account,
      publicClient,
      agent: {
        address: agent.address,
        write: (c) => wallet.writeContract({ address: account, abi: agentAccountAbi, functionName: c.functionName, args: c.args as never, ...(c.gas ? { gas: c.gas } : {}) } as never),
      },
    },
    strategy,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
