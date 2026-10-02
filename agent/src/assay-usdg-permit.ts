// One signature, one transaction: the payer opens an Assay channel in Paxos's testnet USDG on
// Robinhood Chain with an EIP-2612 permit instead of an approve. openChannelWithPermit falls back to
// an existing allowance when the permit call fails, so the check that the permit itself executed is
// the payer's USDG nonce moving by one, with no prior allowance.
//
//   PRIVATE_KEY (payer) and PROVIDER_PRIVATE_KEY from ../.env; npm run assay-usdg-permit
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEventLogs, toBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { RHC_TESTNET_ID } from './account.ts';

const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const ASSAY: Address = (process.env.USDG_ASSAY_ADDRESS as Address | undefined) ?? '0xcF4a98E21D4180b32B9726ef3d0A550A69973f9d';
const USDG: Address = '0x7E955252E15c84f5768B83c41a71F9eba181802F';
const GATEWAY_MEASUREMENT: Hex = '0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149';
const PINNED_MODEL = 'phala/qwen3.8-27b-uncensored';
const AMOUNT = BigInt(process.env.DEPOSIT ?? '1000000');

const usdgAbi = parseAbi([
  'function nonces(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function name() view returns (string)',
]);

function key(name: string): Hex {
  const k = (process.env[name] ?? '').trim();
  if (!k) throw new Error(`${name} is not set.`);
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}

const chain = defineChain({
  id: RHC_TESTNET_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const payer = createWalletClient({ account: privateKeyToAccount(key('PRIVATE_KEY')), chain, transport: http(RPC) });
const provider = privateKeyToAccount(key('PROVIDER_PRIVATE_KEY')).address;
const me = payer.account.address;

const read = <T>(functionName: 'nonces' | 'balanceOf' | 'allowance' | 'name', args: readonly unknown[], blockNumber?: bigint) =>
  pub.readContract({ address: USDG, abi: usdgAbi, functionName, args: args as never, blockNumber }) as Promise<T>;

if ((await read<bigint>('allowance', [me, ASSAY])) !== 0n) throw new Error('payer already has an allowance on this Assay; the permit would not be what pays');
const [nonce, balBefore, assayBefore, name] = await Promise.all([
  read<bigint>('nonces', [me]),
  read<bigint>('balanceOf', [me]),
  read<bigint>('balanceOf', [ASSAY]),
  read<string>('name', []),
]);
if (balBefore < AMOUNT) throw new Error(`payer holds ${balBefore} USDG, needs ${AMOUNT} (faucet.paxos.com)`);

// Paxos's USDG has no version(); "1" is the version whose domain separator equals DOMAIN_SEPARATOR() on chain.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
const sig = await payer.signTypedData({
  domain: { name, version: '1', chainId: RHC_TESTNET_ID, verifyingContract: USDG },
  types: { Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ] },
  primaryType: 'Permit',
  message: { owner: me, spender: ASSAY, value: AMOUNT, nonce, deadline },
});
const r = `0x${sig.slice(2, 66)}` as Hex;
const s = `0x${sig.slice(66, 130)}` as Hex;
const v = parseInt(sig.slice(130, 132), 16);
const pin = keccak256(toBytes(PINNED_MODEL));

const hash = await payer.writeContract({
  address: ASSAY,
  abi: assayAbi,
  functionName: 'openChannelWithPermit',
  args: [provider, AMOUNT, GATEWAY_MEASUREMENT, pin, deadline, v, r, s],
});
const rcpt = await pub.waitForTransactionReceipt({ hash });
if (rcpt.status !== 'success') throw new Error(`openChannelWithPermit tx ${hash} reverted`);
const opened = parseEventLogs({ abi: assayAbi, logs: rcpt.logs, eventName: 'ChannelOpened' }).filter((l) => l.address.toLowerCase() === ASSAY.toLowerCase());
if (opened.length !== 1) throw new Error(`expected one ChannelOpened, got ${opened.length}`);
const { channelId, deposit } = opened[0].args;
const at = rcpt.blockNumber;
const [nonceAfter, balAfter, assayAfter, ch] = await Promise.all([
  read<bigint>('nonces', [me], at),
  read<bigint>('balanceOf', [me], at),
  read<bigint>('balanceOf', [ASSAY], at),
  pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId], blockNumber: at }),
]);
if (nonceAfter !== nonce + 1n) throw new Error(`USDG nonce ${nonce} -> ${nonceAfter}: the permit did not execute`);
if (balBefore - balAfter !== AMOUNT || assayAfter - assayBefore !== AMOUNT || deposit !== AMOUNT) throw new Error('USDG did not move by the deposit');
if (ch[0] !== me || ch[1] !== provider || ch[2] !== AMOUNT || ch[9] !== pin) throw new Error(`channel ${channelId} state does not match`);
console.log(
  `openChannelWithPermit tx ${hash} block ${at}: channel ${channelId} on Assay ${ASSAY}, ${AMOUNT} raw USDG (${name}) from ${me} to the Assay, ` +
    `permit nonce ${nonce} -> ${nonceAfter}, pinned ${PINNED_MODEL}`,
);
