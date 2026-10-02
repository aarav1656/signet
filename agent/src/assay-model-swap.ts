// A genuine Phala receipt for the wrong model is refused on chain. The receipt is the one the
// attested agent spent on its first live trade (AgentAccount.execute, Robinhood Chain testnet):
// signed by Phala's registered receipt key, served `llama3-3-70b`. The payer opens an Assay channel
// pinned to a different model, the provider presents that receipt to redeemWithReceipt, and the
// transaction is mined and reverts ModelMismatch with the channel's paid amount unchanged.
//
//   PRIVATE_KEY (payer) and PROVIDER_PRIVATE_KEY from ../.env; npm run assay-model-swap
//   ASSAY_ADDRESS and CHANNEL_ID reuse an open channel on another Assay (e.g. the Paxos USDG Assay).
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  http,
  keccak256,
  parseAbi,
  parseEther,
  toBytes,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { agentAccountAbi } from './account-abi.ts';
import { RHC_CHAIN_ID } from './account.ts';

const RPC = process.env.RHC_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const ASSAY: Address = ((process.env.ASSAY_ADDRESS ?? '').trim() || '0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D') as Address;
const EXISTING_CHANNEL = (process.env.CHANNEL_ID ?? '').trim();
const REDEEM = BigInt(process.env.REDEEM_AMOUNT ?? '1');
const TEST_USDG: Address = '0x3500DaF0ADcE615A0bEF108FF0751ABb34b1FfCC';
const GATEWAY_MEASUREMENT: Hex = '0xfd34caabef222327146cb5c059810f08bf7c41adb6cc48312be21cc228020149';
const FIRST_TRADE: Hex = '0xe50522661b55c797071b56e43aaf2bc91d37c9745a295ff6a5976883dd4ddfa2';
const PINNED_MODEL = 'phala/qwen3.8-27b-uncensored';
const DEPOSIT = 1_000_000n;

const receiptVerifierAbi = parseAbi([
  'function verifyReceipt(bytes32 pubkey, bytes receiptBytes, bytes signature) view returns (bool ok, bytes32 requestedModelHash, bytes32 servedModelHash, bytes32 requestHash, bytes32 responseHash)',
]);
const erc20Abi = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)']);

function key(name: string): Hex {
  const k = (process.env[name] ?? '').trim();
  if (!k) throw new Error(`${name} is not set.`);
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
}

const chain = defineChain({
  id: RHC_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const pub = createPublicClient({ chain, transport: http(RPC) });
const payer = createWalletClient({ account: privateKeyToAccount(key('PRIVATE_KEY')), chain, transport: http(RPC) });
const provider = createWalletClient({ account: privateKeyToAccount(key('PROVIDER_PRIVATE_KEY')), chain, transport: http(RPC) });

async function mined(hash: Hex, what: string) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${what} tx ${hash} reverted`);
  return r;
}

// 1. The real receipt, straight from the first trade's calldata, and what the verifier reads from it.
const tradeTx = await pub.getTransaction({ hash: FIRST_TRADE });
const { args } = decodeFunctionData({ abi: agentAccountAbi, data: tradeTx.input });
const receipt = (args as unknown as [unknown, { pubkey: Hex; receiptBytes: Hex; signature: Hex }])[1];
const verifier = (await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptVerifier' })) as Address;
const [ok, requested, served, requestHash, responseHash] = await pub.readContract({
  address: verifier,
  abi: receiptVerifierAbi,
  functionName: 'verifyReceipt',
  args: [receipt.pubkey, receipt.receiptBytes, receipt.signature],
});
if (!ok) throw new Error('the first trade receipt no longer verifies');
const [signerMeasurement, signerExpiry] = await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'receiptSigners', args: [receipt.pubkey] });
const pin = keccak256(toBytes(PINNED_MODEL));
if (served === pin) throw new Error('the receipt already serves the pinned model');
console.log(`receipt from ${FIRST_TRADE}: signature valid under ${receipt.pubkey} (Assay measurement ${signerMeasurement}, expiry ${signerExpiry}); requested ${requested}, served ${served}`);

// 2. Payer opens a channel pinned to another model, or reuses one it already opened.
let channelId: bigint;
if (EXISTING_CHANNEL) {
  channelId = BigInt(EXISTING_CHANNEL);
  const ch = await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId] });
  if (ch[0] !== payer.account.address || ch[1] !== provider.account.address || ch[9] !== pin || ch[7]) throw new Error(`channel ${channelId} is not an open ${PINNED_MODEL} channel from this payer to this provider`);
  console.log(`reusing channel ${channelId} on ${ASSAY}: pinned to ${PINNED_MODEL} (${pin}), deposit ${ch[2]}, paid ${ch[3]}`);
} else {
await mined(await payer.writeContract({ address: TEST_USDG, abi: erc20Abi, functionName: 'mint', args: [payer.account.address, DEPOSIT] }), 'mint');
await mined(await payer.writeContract({ address: TEST_USDG, abi: erc20Abi, functionName: 'approve', args: [ASSAY, DEPOSIT] }), 'approve');
const openHash = await payer.writeContract({
  address: ASSAY,
  abi: assayAbi,
  functionName: 'openChannel',
  args: [provider.account.address, DEPOSIT, GATEWAY_MEASUREMENT, pin],
});
const openRcpt = await mined(openHash, 'openChannel');
channelId = (await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channelCount', blockNumber: openRcpt.blockNumber })) - 1n;
const ch = await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId] });
if (ch[0] !== payer.account.address || ch[9] !== pin) throw new Error(`channel ${channelId} is not the one just opened`);
console.log(`openChannel tx ${openHash} block ${openRcpt.blockNumber}: channel ${channelId} pinned to ${PINNED_MODEL} (${pin}), deposit ${DEPOSIT}`);
}

// 3. Provider gas, then the payer's voucher over the receipt's own request and response hashes.
if ((await pub.getBalance({ address: provider.account.address })) < parseEther('0.0002')) {
  await mined(await payer.sendTransaction({ to: provider.account.address, value: parseEther('0.0003') }), 'fund provider');
}
const payerSig = await payer.signTypedData({
  domain: { name: 'Assay', version: '1', chainId: RHC_CHAIN_ID, verifyingContract: ASSAY },
  types: { Voucher: [
    { name: 'channelId', type: 'uint256' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'requestHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
  ] },
  primaryType: 'Voucher',
  message: { channelId, cumulativeAmount: REDEEM, requestHash, responseHash },
});
const redeemArgs = [channelId, REDEEM, requestHash, responseHash, payerSig, receipt.pubkey, receipt.receiptBytes, receipt.signature] as const;

// 4. The refusal: eth_call names the error, then one real transaction is mined and reverts.
let errorName = 'none';
try {
  await pub.simulateContract({ address: ASSAY, abi: assayAbi, functionName: 'redeemWithReceipt', args: redeemArgs, account: provider.account });
} catch (e) {
  const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
  errorName = rev instanceof ContractFunctionRevertedError ? (rev.data?.errorName ?? 'unknown') : 'unknown';
}
if (errorName !== 'ModelMismatch') throw new Error(`redeemWithReceipt eth_call gave ${errorName}, expected ModelMismatch`);
const hash = await provider.writeContract({ address: ASSAY, abi: assayAbi, functionName: 'redeemWithReceipt', args: redeemArgs, gas: 1_500_000n });
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== 'reverted') throw new Error(`redeemWithReceipt tx ${hash} did not revert`);
const before = await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId], blockNumber: r.blockNumber - 1n });
const after = await pub.readContract({ address: ASSAY, abi: assayAbi, functionName: 'channels', args: [channelId], blockNumber: r.blockNumber });
if (after[3] !== before[3]) throw new Error(`channel ${channelId} paid ${after[3]} after a refused redeem`);
console.log(`redeemWithReceipt tx ${hash} block ${r.blockNumber}: reverted ModelMismatch (eth_call), channel ${channelId} paid ${after[3]}`);
