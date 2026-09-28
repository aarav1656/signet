// CLI entrypoint: `refuse` demonstrates the live gateway-signer check against
// a fresh, unregistered address (no PHALA_API_KEY needed, no payment).
// `pay` runs the real three-call paid flow (legacy ECDSA enclave signature),
// but refuses before any network call if PHALA_API_KEY is absent.
// `pay-receipt` runs the newer Phala canonical ACI receipt flow
// (redeemWithReceipt()): fetches the receipt, verifies it locally (JCS +
// Ed25519, same bytes IReceiptVerifier.verifyReceipt checks onchain), and
// refuses -- before ever signing a voucher -- if the receipt's served model
// differs from what was requested. Same PHALA_API_KEY precondition as `pay`.
import { randomUUID } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  http,
  recoverAddress,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { assay, channelId, phalaApiKey, phalaModel, requirePrivateKey, rpcUrl, usdg } from './config.ts';
import { checkGatewaySigner, explainRefusal } from './gateway-check.ts';
import { enclaveDigest, modelHash, VOUCHER_TYPES, voucherDomain, voucherMessage } from './digest.ts';
import {
  fetchAttestation,
  fetchReceipt,
  fetchSignature,
  receiptSigningInput,
  requestCompletion,
  resolveReceiptKey,
  sha256Hex,
  verifyBodyHashes,
  verifyReceiptLocally,
} from './phala.ts';

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

/// Model-swap refusal, end to end: fetches a Phala canonical ACI receipt,
/// verifies it entirely client-side (Ed25519 over the JCS signing input,
/// upstream.verified, request/response body hashes) BEFORE ever calling
/// walletClient.signTypedData, and refuses (exit 1, no signature, no tx) the
/// moment anything -- a bad signature, an unverified upstream, a body-hash
/// mismatch, or a served model that differs from what was requested --
/// doesn't check out. Only once every local check passes does it sign the
/// voucher and call redeemWithReceipt(), which re-proves the same thing
/// onchain via IReceiptVerifier (see Assay.sol:462-467); this local check is a
/// pre-flight so the agent never pays gas on a call it already knows the
/// contract will revert.
async function runPayReceipt(): Promise<void> {
  const key = phalaApiKey();
  if (!key) {
    console.error('PHALA_API_KEY is not set. Refusing to pay: no receipt can be requested without it.');
    process.exit(1);
  }

  const account = privateKeyToAccount(requirePrivateKey());
  const publicClient = createPublicClient({ chain: chain(), transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: chain(), transport: http(rpcUrl) });

  const chBefore = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [channelId] });
  const provider = chBefore[1];
  const paidBefore = chBefore[3];
  const channelRequestedModelHash = chBefore[9] as Hex;
  const zeroHash: Hex = `0x${'0'.repeat(64)}`;
  if (channelRequestedModelHash === zeroHash) {
    console.error(`REFUSING TO PAY: channel ${channelId} has no requestedModelHash pinned (opened via the legacy path); use "pay" (redeem()), not "pay-receipt".`);
    process.exit(1);
  }
  const requestedHashFromConfig = modelHash(phalaModel);
  if (requestedHashFromConfig !== channelRequestedModelHash) {
    console.error(
      `REFUSING TO PAY: this agent is configured to request model "${phalaModel}" (hash ${requestedHashFromConfig}), ` +
        `but channel ${channelId} is pinned to a different requestedModelHash ${channelRequestedModelHash}. Set PHALA_MODEL to match.`,
    );
    process.exit(1);
  }
  const providerBalBefore = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [provider] });
  console.log(`Channel ${channelId}: agent=${chBefore[0]} provider=${provider} deposit=${chBefore[2]} paid=${paidBefore} requestedModelHash=${channelRequestedModelHash}`);
  console.log(`Provider USDG balance before: ${providerBalBefore}`);

  const amounts = [300000n, 600000n, 900000n];
  let cumulativeAmount = 0n;
  for (let i = 0; i < amounts.length; i++) {
    cumulativeAmount = amounts[i];
    console.log(`\n--- call ${i + 1}/3: cumulativeAmount=${cumulativeAmount} ---`);

    const requestNonce = randomUUID();
    const completion = await requestCompletion('Say a short, distinct fact about payment channels.', requestNonce);
    console.log(`chat_id=${completion.chatId} receipt_id=${completion.receiptId}`);

    const receipt = await fetchReceipt(completion.receiptId);
    const attestationNonce = randomUUID();
    const attestation = await fetchAttestation(attestationNonce);
    if (receipt.workload_keyset_digest !== attestation.workloadKeysetDigest) {
      console.error(
        `REFUSING TO PAY: receipt.workload_keyset_digest ${receipt.workload_keyset_digest} does not match the ` +
          `currently-established keyset ${attestation.workloadKeysetDigest} (spec/aci.md client verification step 2).`,
      );
      process.exit(1);
    }

    let receiptKey;
    try {
      receiptKey = resolveReceiptKey(attestation, receipt.key_id);
    } catch (err) {
      console.error(`REFUSING TO PAY: ${(err as Error).message}`);
      process.exit(1);
    }

    const local = verifyReceiptLocally(receipt, receiptKey.publicKeyHex);
    if (!local.ok) {
      console.error(`REFUSING TO PAY: local receipt verification failed: ${local.reason}`);
      process.exit(1);
    }

    // Provenance guard, same shape as verifyBodyHashes for the legacy path:
    // the receipt's own event_log.request.received/response.returned
    // body_hash entries must equal sha256 of the exact bytes this call sent
    // and received, not just parse cleanly and sign correctly.
    const requestReceived = receipt.event_log.find((e) => e.type === 'request.received');
    const requestBodyHashField = requestReceived?.body_hash as string | undefined;
    const requestBodyOk = requestBodyHashField === `sha256:${sha256Hex(completion.requestBody)}`;
    const responseBodyOk = local.responseHashHex === sha256Hex(completion.responseBody);
    if (!requestBodyOk || !responseBodyOk) {
      console.error(`REFUSING TO PAY: receipt body-hash mismatch (requestBodyOk=${requestBodyOk}, responseBodyOk=${responseBodyOk})`);
      process.exit(1);
    }

    // The model-swap refusal itself: the receipt's own requested and served
    // model fields must be identical, and must equal what this channel is
    // pinned to. Any mismatch here means the provider's enclave routed to a
    // different model than agreed -- refuse before signing anything.
    if (local.servedModel !== local.requestedModel) {
      console.error(
        `REFUSING TO PAY: model swap detected -- requested "${local.requestedModel}" but receipt's upstream.verified reports served model "${local.servedModel}".`,
      );
      process.exit(1);
    }
    if (modelHash(local.requestedModel) !== channelRequestedModelHash) {
      console.error(
        `REFUSING TO PAY: receipt's requested model "${local.requestedModel}" (hash ${modelHash(local.requestedModel)}) ` +
          `does not match channel ${channelId}'s pinned requestedModelHash ${channelRequestedModelHash}.`,
      );
      process.exit(1);
    }
    console.log(`Local receipt check OK: requested="${local.requestedModel}" served="${local.servedModel}" (match), body hashes match sent/received bytes.`);

    const requestHash = `0x${sha256Hex(completion.requestBody)}` as Hex;
    const responseHash = `0x${local.responseHashHex}` as Hex;

    const payerSig = await walletClient.signTypedData({
      account,
      domain: voucherDomain(arbitrumSepolia.id, assay),
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: voucherMessage(channelId, cumulativeAmount, requestHash, responseHash),
    });

    const pubkeyHex = (receiptKey.publicKeyHex.startsWith('0x') ? receiptKey.publicKeyHex : `0x${receiptKey.publicKeyHex}`) as Hex;
    const receiptBytesHex = `0x${Buffer.from(receiptSigningInput(receipt)).toString('hex')}` as Hex;
    const signatureHex = (receipt.signature.startsWith('0x') ? receipt.signature : `0x${receipt.signature}`) as Hex;

    const txHash = await walletClient.writeContract({
      address: assay,
      abi: assayAbi,
      functionName: 'redeemWithReceipt',
      args: [channelId, cumulativeAmount, requestHash, responseHash, payerSig, pubkeyHex, receiptBytesHex, signatureHex],
    });
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`redeemWithReceipt() tx=${txHash} status=${txReceipt.status} block=${txReceipt.blockNumber}`);
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
} else if (mode === 'pay-receipt') {
  await runPayReceipt();
} else {
  console.error('Usage: node src/index.ts <refuse|pay|pay-receipt>');
  process.exit(1);
}
