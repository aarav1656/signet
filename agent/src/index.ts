// CLI entrypoint: `refuse` demonstrates the live gateway-signer check against
// a fresh, unregistered address (no PHALA_API_KEY needed, no payment).
// `pay` runs the real three-call paid flow, but refuses before any network
// call if PHALA_API_KEY is absent.
import { randomUUID } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  recoverAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { assay, channelId, phalaApiKey, requirePrivateKey, rpcUrl, usdg } from './config.ts';
import { checkGatewaySigner, explainRefusal } from './gateway-check.ts';
import { enclaveDigest, VOUCHER_TYPES, voucherDomain, voucherMessage } from './digest.ts';
import { fetchSignature, requestCompletion, verifyBodyHashes } from './phala.ts';

const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

function chain() {
  return { ...arbitrumSepolia, rpcUrls: { default: { http: [rpcUrl] } } };
}

async function runRefuse(): Promise<void> {
  const client = createPublicClient({ chain: chain(), transport: http(rpcUrl) });
  const unregisteredKey = generatePrivateKey();
  const unregisteredSigner = privateKeyToAccount(unregisteredKey).address;
  console.log(`Checking gateway signer ${unregisteredSigner} against Chiron ${assay} on chain ${arbitrumSepolia.id}...`);
  const status = await checkGatewaySigner(client, unregisteredSigner);
  console.log(`signers(${unregisteredSigner}) => measurement=${status.measurement} expiry=${status.expiry} (chain now=${status.now})`);
  if (!status.ok) {
    console.error(`REFUSING TO PAY: ${explainRefusal(status)}`);
    process.exit(1);
  }
  console.log(`Gateway signer is registered, approved and unexpired: ${explainRefusal(status)}`);
}

async function runPay(): Promise<void> {
  const key = phalaApiKey();
  if (!key) {
    console.error('PHALA_API_KEY is not set. Refusing to pay: no enclave signature can be requested without it.');
    process.exit(1);
  }

  const account = privateKeyToAccount(requirePrivateKey());
  const publicClient = createPublicClient({ chain: chain(), transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: chain(), transport: http(rpcUrl) });

  const chBefore = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [channelId] });
  const provider = chBefore[1];
  const paidBefore = chBefore[3];
  const providerBalBefore = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [provider] });
  console.log(`Channel ${channelId}: agent=${chBefore[0]} provider=${provider} deposit=${chBefore[2]} paid=${paidBefore}`);
  console.log(`Provider USDG balance before: ${providerBalBefore}`);

  const amounts = [300000n, 600000n, 900000n];
  let cumulativeAmount = 0n;
  for (let i = 0; i < amounts.length; i++) {
    cumulativeAmount = amounts[i];
    console.log(`\n--- call ${i + 1}/3: cumulativeAmount=${cumulativeAmount} ---`);

    const nonce = randomUUID();
    const completion = await requestCompletion('Say a short, distinct fact about payment channels.', nonce);
    console.log(`chat_id=${completion.chatId}`);

    const sig = await fetchSignature(completion.chatId);
    const { requestOk, responseOk } = verifyBodyHashes(completion, sig);
    if (!requestOk || !responseOk) {
      console.error(`REFUSING TO PAY: receipt body-hash mismatch (requestOk=${requestOk}, responseOk=${responseOk})`);
      process.exit(1);
    }

    const digest = enclaveDigest(sig.requestHash, sig.responseHash);
    const recovered = await recoverAddress({ hash: digest, signature: sig.signature });
    if (recovered.toLowerCase() !== sig.signingAddress.toLowerCase()) {
      console.error(`REFUSING TO PAY: recovered signer ${recovered} does not match Phala's reported signing_address ${sig.signingAddress}`);
      process.exit(1);
    }

    const status = await checkGatewaySigner(publicClient, recovered);
    console.log(`Enclave signer ${recovered}: ${explainRefusal(status)}`);
    if (!status.ok) {
      console.error(`REFUSING TO PAY: ${explainRefusal(status)}`);
      process.exit(1);
    }

    const payerSig = await walletClient.signTypedData({
      account,
      domain: voucherDomain(arbitrumSepolia.id, assay),
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: voucherMessage(channelId, cumulativeAmount, sig.requestHash, sig.responseHash),
    });

    const txHash = await walletClient.writeContract({
      address: assay,
      abi: assayAbi,
      functionName: 'redeem',
      args: [channelId, cumulativeAmount, sig.requestHash, sig.responseHash, payerSig, sig.signature],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`redeem() tx=${txHash} status=${receipt.status} block=${receipt.blockNumber}`);
  }

  const chAfter = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [channelId] });
  const paidAfter = chAfter[3];
  const providerBalAfter = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [provider] });
  const finalBlock = await publicClient.getBlockNumber();

  const paidDelta = paidAfter - paidBefore;
  const balDelta = providerBalAfter - providerBalBefore;
  console.log(`\n--- post-conditions (block ${finalBlock}) ---`);
  console.log(`channels(${channelId}).paid: ${paidBefore} -> ${paidAfter} (delta ${paidDelta})`);
  console.log(`provider USDG balance: ${providerBalBefore} -> ${providerBalAfter} (delta ${balDelta})`);
  if (paidDelta !== cumulativeAmount) throw new Error(`paid delta ${paidDelta} != final cumulativeAmount ${cumulativeAmount}`);
  if (balDelta !== paidDelta) throw new Error(`provider USDG balance delta ${balDelta} != paid delta ${paidDelta}`);
  console.log('OK: paid delta equals the voucher amounts; provider USDG balance delta equals paid delta.');
}

const mode = process.argv[2];
if (mode === 'refuse') {
  await runRefuse();
} else if (mode === 'pay') {
  await runPay();
} else {
  console.error('Usage: node src/index.ts <refuse|pay>');
  process.exit(1);
}
