import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { accountAbi } from '../../abi/AgentAccount.generated';

/// The CVM answers in the agent's wire format: bigints travel as {"$bigint":"<decimal>"}.
const fromWire = <T,>(s: string): T =>
  JSON.parse(s, (_k, x) => (x !== null && typeof x === 'object' && typeof x.$bigint === 'string' && Object.keys(x).length === 1 ? BigInt(x.$bigint) : x)) as T;

const verifyAbi = [
  {
    type: 'function',
    name: 'verify',
    inputs: [{ name: 'quote', type: 'bytes' }, { name: 'nonce', type: 'bytes32' }],
    outputs: [{ name: 'signer', type: 'address' }, { name: 'measurement', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
] as const;

export type OperatorQuote = { agent: Address; refBlock: bigint; nonce: Hex; quote: Hex; signer: Address; measurement: Hex };

/** Ask an operator's CVM for a quote bound to `account`'s own nonce, then ask this account's Stylus
 *  Verifier which key and measurement the quote proves. Throws when the quote is for another account
 *  or the Verifier's signer is not the key the CVM reports. */
export async function readOperatorQuote(c: PublicClient, cvmUrl: string, account: Address, f: typeof fetch = fetch): Promise<OperatorQuote> {
  const base = cvmUrl.trim().replace(/\/$/, '');
  const res = await f(`${base}/quote?account=${account}`, { method: 'POST' });
  const q = fromWire<{ agent: Address; account?: Address; refBlock: bigint; nonce: Hex; quote: Hex; error?: string }>(await res.text());
  if (!res.ok || !q.quote) throw new Error(`The CVM did not return a quote: ${q.error ?? `HTTP ${res.status}`}`);
  if (q.account && getAddress(q.account) !== getAddress(account)) throw new Error(`The CVM bound its quote to ${q.account}, not this account`);
  const verifier = (await c.readContract({ address: account, abi: accountAbi, functionName: 'verifier' })) as Address;
  const { result } = await c.simulateContract({ address: verifier, abi: verifyAbi, functionName: 'verify', args: [q.quote, q.nonce] });
  const [signer, measurement] = result;
  if (getAddress(signer) !== getAddress(q.agent)) throw new Error(`The Verifier proves key ${signer}, but the CVM reports ${q.agent}`);
  return { agent: getAddress(q.agent), refBlock: q.refBlock, nonce: q.nonce, quote: q.quote, signer, measurement };
}
