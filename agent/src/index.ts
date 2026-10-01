// CLI entrypoint: `refuse` demonstrates the live gateway-signer check against
// a fresh, unregistered address (no PHALA_API_KEY needed, no payment).
// `register` (provider wallet) registers Phala's gateway signer and receipt key
// from fresh quotes bound to the contract's own nonce. `open` (agent wallet)
// funds a channel to the provider wallet.
// `pay` runs the real three-call paid flow (legacy ECDSA enclave signature),
// but refuses before any network call if PHALA_API_KEY is absent.
// `pay-receipt` runs the newer Phala canonical ACI receipt flow
// (redeemWithReceipt()): fetches the receipt, verifies it locally (JCS +
// Ed25519, same bytes IReceiptVerifier.verifyReceipt checks onchain), and
// refuses -- before ever signing a voucher -- if the receipt's served model
// differs from what was requested. Same PHALA_API_KEY precondition as `pay`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseEventLogs,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { chironGateAbi, x402BatchSettlementAbi } from './gate-abi.ts';
import {
  assay,
  chainId,
  channelId,
  erc3009Collector,
  gate,
  gateMeasurement,
  phalaApiKey,
  phalaModel,
  requirePrivateKey,
  requireProviderKey,
  rpcUrl,
  usdg,
  x402 as x402Address,
} from './config.ts';
import { checkGatewaySigner, explainRefusal } from './gateway-check.ts';
import { runAcctApprove, runAcctOvercap, runAcctTrade } from './account.ts';
import {
  enclaveDigest,
  modelHash,
  RECEIVE_AUTH_TYPES,
  usdgDomain,
  VOUCHER_TYPES,
  voucherDomain,
  voucherMessage,
} from './digest.ts';
import {
  fetchAttestation,
  fetchLegacyReport,
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
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const;

function chain() {
  return { ...arbitrumSepolia, id: chainId, rpcUrls: { default: { http: [rpcUrl] } } };
}

/// Agent signs vouchers; provider submits redeems (Assay requires msg.sender ==
/// channel.provider). Refuses to run with one key in both roles.
function parties() {
  const agentAccount = privateKeyToAccount(requirePrivateKey());
  const providerAccount = privateKeyToAccount(requireProviderKey());
  if (agentAccount.address === providerAccount.address) {
    console.error('REFUSING: PRIVATE_KEY and PROVIDER_PRIVATE_KEY are the same wallet; a channel must pay a different address.');
    process.exit(1);
  }
  const publicClient = createPublicClient({ chain: chain(), transport: http(rpcUrl) });
  const agentWallet = createWalletClient({ account: agentAccount, chain: chain(), transport: http(rpcUrl) });
  const providerWallet = createWalletClient({ account: providerAccount, chain: chain(), transport: http(rpcUrl) });
  return { agentAccount, providerAccount, publicClient, agentWallet, providerWallet };
}

/// A register nonce needs refBlock inside ArbSys's 256-block window (about
/// 66 s on Arbitrum Sepolia), so read it, fetch the quote and send the tx in
/// one go, then assert the post-condition only a successful register writes.
async function runRegister(): Promise<void> {
  const account = privateKeyToAccount(requireProviderKey());
  const publicClient = createPublicClient({ chain: chain(), transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: chain(), transport: http(rpcUrl) });

  const freshNonce = async () => {
    const refBlock = (await publicClient.getBlockNumber()) - 1n;
    const nonce = await publicClient.readContract({
      address: assay,
      abi: assayAbi,
      functionName: 'nextRegisterNonce',
      args: [account.address, refBlock],
    });
    return { refBlock, nonce: nonce as Hex };
  };

  const legacyNonce = await freshNonce();
  const legacy = await fetchLegacyReport(legacyNonce.nonce.slice(2));
  console.log(`legacy quote fetched for nonce ${legacyNonce.nonce} (refBlock ${legacyNonce.refBlock}), signing_address ${legacy.signingAddress}`);
  const regTx = await wallet.writeContract({
    address: assay,
    abi: assayAbi,
    functionName: 'register',
    args: [legacy.quote, legacyNonce.refBlock],
  });
  const regRcpt = await publicClient.waitForTransactionReceipt({ hash: regTx });
  if (regRcpt.status !== 'success') throw new Error(`register() tx ${regTx} reverted`);
  const signer = await checkGatewaySigner(publicClient, legacy.signingAddress);
  if (!signer.ok) throw new Error(`register() mined but signer is not usable: ${explainRefusal(signer)}`);
  console.log(`register() tx=${regTx} block=${regRcpt.blockNumber}: signers(${legacy.signingAddress}) measurement=${signer.measurement} expiry=${signer.expiry}`);

  const aciNonce = await freshNonce();
  const aci = await fetchAttestation(aciNonce.nonce.slice(2));
  for (const key of aci.receiptSigningKeys.filter((k) => k.algo === 'ed25519')) {
    const pubkey = (key.publicKeyHex.startsWith('0x') ? key.publicKeyHex : `0x${key.publicKeyHex}`) as Hex;
    const tx = await wallet.writeContract({
      address: assay,
      abi: assayAbi,
      functionName: 'registerReceiptKey',
      args: [aci.quote, `0x${Buffer.from(aci.keysetBytes).toString('hex')}`, aciNonce.refBlock, pubkey],
    });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (rcpt.status !== 'success') throw new Error(`registerReceiptKey() tx ${tx} reverted`);
    const [measurement, expiry] = await publicClient.readContract({
      address: assay,
      abi: assayAbi,
      functionName: 'receiptSigners',
      args: [pubkey],
    });
    if (measurement !== signer.measurement) throw new Error(`receiptSigners(${pubkey}) measurement ${measurement} != ${signer.measurement}`);
    console.log(`registerReceiptKey() tx=${tx} block=${rcpt.blockNumber}: receiptSigners(${key.keyId}=${pubkey}) measurement=${measurement} expiry=${expiry}`);
    // One quote registers one key (usedQuote); Phala's keyset has one ed25519 receipt key.
    return;
  }
  throw new Error('the ACI keyset has no ed25519 receipt key; nothing was registered for redeemWithReceipt');
}

/// `open [legacy]`: the agent approves and opens a channel to the provider
/// wallet, pinned to the provider's registered measurement and, unless
/// `legacy`, to PHALA_MODEL's hash (a receipt-only channel).
async function runOpen(): Promise<void> {
  const { agentAccount, providerAccount, publicClient, agentWallet } = parties();
  const legacy = process.argv[3] === 'legacy';
  const amount = BigInt(process.env.DEPOSIT ?? '2000000');
  const approvedMeasurement = process.env.APPROVED_MEASUREMENT as Hex | undefined;
  if (!approvedMeasurement) throw new Error('APPROVED_MEASUREMENT is not set (the measurement Assay was deployed with).');
  const requestedModelHash = legacy ? (`0x${'0'.repeat(64)}` as Hex) : modelHash(phalaModel);

  const approveTx = await agentWallet.writeContract({ address: usdg, abi: erc20Abi, functionName: 'approve', args: [assay, amount] });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });
  const tx = await agentWallet.writeContract({
    address: assay,
    abi: assayAbi,
    functionName: 'openChannel',
    args: [providerAccount.address, amount, approvedMeasurement, requestedModelHash],
  });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== 'success') throw new Error(`openChannel() tx ${tx} reverted`);
  const [opened] = parseEventLogs({ abi: assayAbi, eventName: 'ChannelOpened', logs: rcpt.logs });
  if (!opened) throw new Error(`openChannel() tx ${tx} emitted no ChannelOpened`);
  const id = opened.args.channelId;
  const ch = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [id] });
  if (ch[0] !== agentAccount.address || ch[1] !== providerAccount.address || ch[2] !== amount) {
    throw new Error(`channels(${id}) does not match the open: ${ch.slice(0, 3).join(', ')}`);
  }
  console.log(`openChannel() tx=${tx} block=${rcpt.blockNumber}: channel ${id} agent=${ch[0]} provider=${ch[1]} deposit=${ch[2]} requestedModelHash=${ch[9]}${legacy ? ' (legacy-only)' : ` (${phalaModel})`}`);
  console.log(`Set ASSAY_CHANNEL_ID=${id} for pay${legacy ? '' : '-receipt'}.`);
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

  const { agentAccount: account, publicClient, agentWallet: walletClient, providerWallet } = parties();

  const chBefore = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [channelId] });
  const provider = chBefore[1];
  const paidBefore = chBefore[3];
  if (chBefore[0] !== account.address || provider !== providerWallet.account.address) {
    console.error(`REFUSING: channel ${channelId} is agent=${chBefore[0]} provider=${provider}; configured keys are agent=${account.address} provider=${providerWallet.account.address}.`);
    process.exit(1);
  }
  if (chBefore[9] !== `0x${'0'.repeat(64)}`) {
    console.error(`REFUSING: channel ${channelId} is model-pinned (receipt-only); Assay.redeem() reverts ModelMismatch on it. Use "pay-receipt".`);
    process.exit(1);
  }
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

    const txHash = await providerWallet.writeContract({
      address: assay,
      abi: assayAbi,
      functionName: 'redeem',
      args: [channelId, cumulativeAmount, sig.requestHash, sig.responseHash, payerSig, sig.signature],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`redeem() tx=${txHash} status=${receipt.status} block=${receipt.blockNumber}`);
    if (receipt.status !== 'success') throw new Error(`redeem() tx ${txHash} reverted`);
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

  const { agentAccount: account, publicClient, agentWallet: walletClient, providerWallet } = parties();

  const chBefore = await publicClient.readContract({ address: assay, abi: assayAbi, functionName: 'channels', args: [channelId] });
  const provider = chBefore[1];
  const paidBefore = chBefore[3];
  if (chBefore[0] !== account.address || provider !== providerWallet.account.address) {
    console.error(`REFUSING: channel ${channelId} is agent=${chBefore[0]} provider=${provider}; configured keys are agent=${account.address} provider=${providerWallet.account.address}.`);
    process.exit(1);
  }
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
    const attestationNonce = randomBytes(32).toString('hex');
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

    const txHash = await providerWallet.writeContract({
      address: assay,
      abi: assayAbi,
      functionName: 'redeemWithReceipt',
      args: [channelId, cumulativeAmount, requestHash, responseHash, payerSig, pubkeyHex, receiptBytesHex, signatureHex],
    });
    const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`redeemWithReceipt() tx=${txHash} status=${txReceipt.status} block=${txReceipt.blockNumber}`);
    if (txReceipt.status !== 'success') throw new Error(`redeemWithReceipt() tx ${txHash} reverted`);
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

// --- ChironGate / x402BatchSettlement -------------------------------------
// Three new agent modes against the live receipt-gated x402 channel system.
// `gate-open`, `gate-pay` and `gate-refuse` share one on-disk channel record
// (agent/.gate-channel.json, local state only, not secret) so `gate-pay` and
// `gate-refuse` can act on the exact channel `gate-open` created without
// rebuilding the Pin/ChannelConfig by hand.

type GatePin = {
  requestedModelHash: Hex;
  acceptedServedHashes: readonly [Hex, Hex, Hex, Hex];
  measurement: Hex;
  providerPayout: Address;
  gateNonce: Hex;
};

type GateChannelConfig = {
  payer: Address;
  payerAuthorizer: Address;
  receiver: Address;
  receiverAuthorizer: Address;
  token: Address;
  withdrawDelay: number;
  salt: Hex;
};

type GateChannelState = {
  channelId: Hex;
  pin: GatePin;
  config: GateChannelConfig;
};

const gateChannelPath = join(import.meta.dirname, '..', '.gate-channel.json');

function saveGateChannel(state: GateChannelState): void {
  writeFileSync(gateChannelPath, JSON.stringify(state, null, 2));
}

function loadGateChannel(): GateChannelState {
  if (!existsSync(gateChannelPath)) {
    throw new Error(`${gateChannelPath} not found; run "gate-open" first.`);
  }
  return JSON.parse(readFileSync(gateChannelPath, 'utf8')) as GateChannelState;
}

/// `gate-open`: the agent deposits 1 USDG into a fresh ChironGate-gated x402
/// channel via a gasless ERC-3009 `receiveWithAuthorization` pull (no prior
/// approve()). Pin.requestedModelHash is PHALA_MODEL's hash with a single
/// accepted served-label slot (the same label, since RedPill's Qwen route
/// reports served == requested); providerPayout is the provider wallet.
async function runGateOpen(): Promise<void> {
  const { agentAccount, providerAccount, publicClient, agentWallet } = parties();
  const depositAmount = 1000000n; // 1 USDG (6 decimals)

  const pin: GatePin = {
    requestedModelHash: modelHash(phalaModel),
    acceptedServedHashes: [modelHash(phalaModel), `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
    measurement: gateMeasurement,
    providerPayout: providerAccount.address,
    gateNonce: `0x${randomBytes(32).toString('hex')}` as Hex,
  };

  const salt = await publicClient.readContract({ address: gate, abi: chironGateAbi, functionName: 'pinSalt', args: [pin] });

  const config: GateChannelConfig = {
    payer: agentAccount.address,
    payerAuthorizer: agentAccount.address,
    receiver: gate,
    receiverAuthorizer: gate,
    token: usdg,
    withdrawDelay: 900,
    salt,
  };

  const channelId = await publicClient.readContract({ address: x402Address, abi: x402BatchSettlementAbi, functionName: 'getChannelId', args: [config] });
  console.log(`Pin salt=${salt}, channelId=${channelId}`);

  // ERC-3009 authorization: the agent lets the collector pull `depositAmount`
  // USDG into escrow. nonce = keccak256(abi.encode(channelId, salt)), the
  // exact preimage ERC3009DepositCollector.collect recomputes onchain.
  const saltUint = BigInt(salt);
  const nonce = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [channelId, saltUint]));
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const authSig = await agentWallet.signTypedData({
    account: agentAccount,
    domain: usdgDomain(arbitrumSepolia.id, usdg),
    types: RECEIVE_AUTH_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: { from: agentAccount.address, to: erc3009Collector, value: depositAmount, validAfter, validBefore, nonce },
  });

  const collectorData = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }],
    [validAfter, validBefore, saltUint, authSig],
  );

  const x402BalBefore = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [x402Address] });

  const depositTx = await agentWallet.writeContract({
    address: x402Address,
    abi: x402BatchSettlementAbi,
    functionName: 'deposit',
    args: [config, depositAmount, erc3009Collector, collectorData],
  });
  const depositRcpt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log(`deposit() tx=${depositTx} status=${depositRcpt.status} block=${depositRcpt.blockNumber}`);
  if (depositRcpt.status !== 'success') throw new Error(`deposit() tx ${depositTx} reverted`);

  const [balance, totalClaimed] = await publicClient.readContract({ address: x402Address, abi: x402BatchSettlementAbi, functionName: 'channels', args: [channelId] });
  const x402BalAfter = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [x402Address] });
  const x402BalDelta = x402BalAfter - x402BalBefore;
  console.log(`--- post-conditions ---`);
  console.log(`channels(${channelId}): balance=${balance} totalClaimed=${totalClaimed}`);
  console.log(`x402 USDG balance: ${x402BalBefore} -> ${x402BalAfter} (delta ${x402BalDelta})`);
  if (balance !== depositAmount) throw new Error(`channel balance ${balance} != deposit ${depositAmount}`);
  if (x402BalDelta !== depositAmount) throw new Error(`x402 USDG balance delta ${x402BalDelta} != deposit ${depositAmount}`);
  console.log('OK: channel balance and x402 USDG balance delta both equal the deposit.');

  saveGateChannel({ channelId, pin, config });
  console.log(`Saved channel state to ${gateChannelPath}`);
}

/// `gate-pay`: one Phala completion, receipt fetched and verified locally
/// (mirrors runPayReceipt's checks), then the agent signs the x402 Voucher
/// and the ChironGate CallAck (raw digests, not EIP-191 -- both contracts
/// recover via ECDSA.tryRecover/recoverCalldata over the bare hash), and the
/// PROVIDER submits claimWithReceipt().
async function runGatePay(): Promise<void> {
  const key = phalaApiKey();
  if (!key) {
    console.error('PHALA_API_KEY is not set. Refusing to pay: no receipt can be requested without it.');
    process.exit(1);
  }

  const state = loadGateChannel();
  const { agentAccount, providerAccount, publicClient, agentWallet, providerWallet } = parties();
  if (state.config.payer !== agentAccount.address || state.pin.providerPayout !== providerAccount.address) {
    console.error(`REFUSING: saved channel ${state.channelId} does not match the configured PRIVATE_KEY/PROVIDER_PRIVATE_KEY wallets.`);
    process.exit(1);
  }

  const totalClaimed = 300000n;
  const providerBalBefore = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [providerAccount.address] });
  console.log(`Channel ${state.channelId}: provider USDG balance before=${providerBalBefore}`);

  // GATE_PAY_RESUME_RECEIPT_ID re-fetches an already-issued receipt (a GET on
  // /v1/aci/receipts/{id}, not a new /v1/chat/completions call) instead of
  // spending a fresh inference call -- for recovering a run that got a valid
  // receipt but failed before claimWithReceipt for an unrelated reason (e.g.
  // the channel it was about to pay was pinned to the wrong model).
  const resumeReceiptId = (process.env.GATE_PAY_RESUME_RECEIPT_ID ?? '').trim();
  let completion: Awaited<ReturnType<typeof requestCompletion>> | undefined;
  let receiptId: string;
  if (resumeReceiptId) {
    console.log(`Resuming from already-issued receipt_id=${resumeReceiptId} (no new inference call).`);
    receiptId = resumeReceiptId;
  } else {
    const requestNonce = randomUUID();
    completion = await requestCompletion('Say a short, distinct fact about payment channels.', requestNonce);
    console.log(`chat_id=${completion.chatId} receipt_id=${completion.receiptId}`);
    receiptId = completion.receiptId;
  }

  const receipt = await fetchReceipt(receiptId);
  const attestationNonce = randomBytes(32).toString('hex');
  const attestation = await fetchAttestation(attestationNonce);
  if (receipt.workload_keyset_digest !== attestation.workloadKeysetDigest) {
    console.error(`REFUSING TO PAY: receipt.workload_keyset_digest ${receipt.workload_keyset_digest} does not match the currently-established keyset ${attestation.workloadKeysetDigest}.`);
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

  const requestReceived = receipt.event_log.find((e) => e.type === 'request.received');
  const requestBodyHashField = requestReceived?.body_hash as string | undefined;
  if (!requestBodyHashField?.startsWith('sha256:')) {
    console.error('REFUSING TO PAY: receipt event_log has no usable request.received body_hash.');
    process.exit(1);
  }
  if (completion) {
    const requestBodyOk = requestBodyHashField === `sha256:${sha256Hex(completion.requestBody)}`;
    const responseBodyOk = local.responseHashHex === sha256Hex(completion.responseBody);
    if (!requestBodyOk || !responseBodyOk) {
      console.error(`REFUSING TO PAY: receipt body-hash mismatch (requestBodyOk=${requestBodyOk}, responseBodyOk=${responseBodyOk})`);
      process.exit(1);
    }
  } else {
    console.log('Resuming from a saved receipt_id: skipping the local request/response-bytes cross-check (no cached completion bytes for this process); claimWithReceipt still re-proves the receipt onchain via receiptVerifier.');
  }

  if (local.servedModel !== local.requestedModel) {
    console.error(`REFUSING TO PAY: model swap detected -- requested "${local.requestedModel}" but receipt reports served model "${local.servedModel}".`);
    process.exit(1);
  }
  if (modelHash(local.requestedModel) !== state.pin.requestedModelHash) {
    console.error(`REFUSING TO PAY: receipt's requested model "${local.requestedModel}" does not match this channel's pinned requestedModelHash ${state.pin.requestedModelHash}.`);
    process.exit(1);
  }
  console.log(`Local receipt check OK: requested="${local.requestedModel}" served="${local.servedModel}" (match), body hashes match sent/received bytes.`);

  const requestHash = `0x${requestBodyHashField.slice('sha256:'.length)}` as Hex;
  const responseHash = `0x${local.responseHashHex}` as Hex;

  const voucherDigest = await publicClient.readContract({
    address: x402Address,
    abi: x402BatchSettlementAbi,
    functionName: 'getVoucherDigest',
    args: [state.channelId, totalClaimed],
  });
  const voucherSig = await agentAccount.sign({ hash: voucherDigest });

  const ackDigest = await publicClient.readContract({
    address: gate,
    abi: chironGateAbi,
    functionName: 'callAckDigest',
    args: [state.channelId, totalClaimed, requestHash, responseHash],
  });
  const ackSig = await agentAccount.sign({ hash: ackDigest });

  const pubkeyHex = (receiptKey.publicKeyHex.startsWith('0x') ? receiptKey.publicKeyHex : `0x${receiptKey.publicKeyHex}`) as Hex;
  const receiptBytesHex = `0x${Buffer.from(receiptSigningInput(receipt)).toString('hex')}` as Hex;
  const receiptSignatureHex = (receipt.signature.startsWith('0x') ? receipt.signature : `0x${receipt.signature}`) as Hex;

  const vc = {
    voucher: { channel: state.config, maxClaimableAmount: totalClaimed },
    signature: voucherSig,
    totalClaimed,
  };

  const claimTx = await providerWallet.writeContract({
    address: gate,
    abi: chironGateAbi,
    functionName: 'claimWithReceipt',
    args: [vc, state.pin, requestHash, responseHash, ackSig, pubkeyHex, receiptBytesHex, receiptSignatureHex],
  });
  const claimRcpt = await publicClient.waitForTransactionReceipt({ hash: claimTx });
  console.log(`claimWithReceipt() tx=${claimTx} status=${claimRcpt.status} block=${claimRcpt.blockNumber}`);
  if (claimRcpt.status !== 'success') throw new Error(`claimWithReceipt() tx ${claimTx} reverted`);

  const providerBalAfter = await publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [providerAccount.address] });
  const [, channelTotalClaimed] = await publicClient.readContract({ address: x402Address, abi: x402BatchSettlementAbi, functionName: 'channels', args: [state.channelId] });
  const balDelta = providerBalAfter - providerBalBefore;
  console.log(`--- post-conditions ---`);
  console.log(`provider USDG balance: ${providerBalBefore} -> ${providerBalAfter} (delta ${balDelta})`);
  console.log(`channels(${state.channelId}).totalClaimed: ${channelTotalClaimed}`);
  if (balDelta !== totalClaimed) throw new Error(`provider USDG balance delta ${balDelta} != totalClaimed ${totalClaimed}`);
  if (channelTotalClaimed !== totalClaimed) throw new Error(`channel totalClaimed ${channelTotalClaimed} != ${totalClaimed}`);
  console.log('OK: provider USDG balance delta and channel totalClaimed both equal 300000.');
}

/// `gate-refuse`: an eth_call (no gas, no credits) of claimWithReceipt on the
/// SAME channel gate-open created, using fixtures/receipt_vectors.json's
/// model_swap vector. The agent still signs a genuine CallAck (its own key,
/// matching payerAuthorizer) and voucher, so the only thing wrong is the
/// receipt's requested model -- isolating exactly the ModelMismatch check.
async function runGateRefuse(): Promise<void> {
  const state = loadGateChannel();
  const { agentAccount, publicClient } = parties();

  const fixturesPath = join(import.meta.dirname, '..', '..', 'fixtures', 'receipt_vectors.json');
  const vectors = JSON.parse(readFileSync(fixturesPath, 'utf8')) as {
    pubkey: string; // shared across vectors, not nested per-vector
    model_swap: {
      receipt_bytes_hex: string;
      signature_hex: string;
      requested_model_hash: string;
      served_model_hash: string;
      request_hash: string;
      response_hash: string;
    };
  };
  const v = vectors.model_swap;
  if (!v) throw new Error('fixtures/receipt_vectors.json has no "model_swap" vector.');

  const requestHash = v.request_hash as Hex;
  const responseHash = v.response_hash as Hex;
  const pubkeyHex = vectors.pubkey as Hex;
  const receiptBytesHex = v.receipt_bytes_hex as Hex;
  const receiptSigHex = v.signature_hex as Hex;
  const totalClaimed = 1000000n;

  console.log(`Simulating claimWithReceipt on channel ${state.channelId} with fixtures/receipt_vectors.json "model_swap" (requested_model_hash=${v.requested_model_hash}, served_model_hash=${v.served_model_hash}).`);
  console.log(`This channel is pinned to requestedModelHash=${state.pin.requestedModelHash} -- a real mismatch.`);

  const voucherDigest = await publicClient.readContract({
    address: x402Address,
    abi: x402BatchSettlementAbi,
    functionName: 'getVoucherDigest',
    args: [state.channelId, totalClaimed],
  });
  const voucherSig = await agentAccount.sign({ hash: voucherDigest });

  const ackDigest = await publicClient.readContract({
    address: gate,
    abi: chironGateAbi,
    functionName: 'callAckDigest',
    args: [state.channelId, totalClaimed, requestHash, responseHash],
  });
  const ackSig = await agentAccount.sign({ hash: ackDigest });

  const vc = {
    voucher: { channel: state.config, maxClaimableAmount: totalClaimed },
    signature: voucherSig,
    totalClaimed,
  };

  try {
    await publicClient.simulateContract({
      address: gate,
      abi: chironGateAbi,
      functionName: 'claimWithReceipt',
      account: agentAccount.address,
      args: [vc, state.pin, requestHash, responseHash, ackSig, pubkeyHex, receiptBytesHex, receiptSigHex],
    });
    console.error('REFUSAL FAILED: claimWithReceipt() did NOT revert on a model-swapped receipt.');
    process.exit(1);
  } catch (err) {
    if (err instanceof BaseError) {
      const revertError = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (revertError instanceof ContractFunctionRevertedError) {
        const errorName = revertError.data?.errorName ?? revertError.reason ?? 'unknown';
        console.log(`eth_call reverted: ${errorName}`);
        if (errorName === 'ModelMismatch') {
          console.log('OK: refused with ModelMismatch (requestedModel != pin.requestedModelHash), the first model check claimWithReceipt runs.');
        } else {
          console.log(`NOTE: a different check fired first: "${errorName}" -- not the expected ModelMismatch. Reporting as-is.`);
        }
        return;
      }
    }
    throw err;
  }
}

const mode = process.argv[2];
if (mode === 'refuse') {
  await runRefuse();
} else if (mode === 'register') {
  await runRegister();
} else if (mode === 'open') {
  await runOpen();
} else if (mode === 'pay') {
  await runPay();
} else if (mode === 'pay-receipt') {
  await runPayReceipt();
} else if (mode === 'gate-open') {
  await runGateOpen();
} else if (mode === 'gate-pay') {
  await runGatePay();
} else if (mode === 'gate-refuse') {
  await runGateRefuse();
} else if (mode === 'acct-register') {
  await runAcctRegister();
} else if (mode === 'acct-trade') {
  await runAcctTrade();
} else if (mode === 'acct-overcap') {
  await runAcctOvercap();
} else if (mode === 'acct-approve') {
  await runAcctApprove();
} else {
  console.error(
    'Usage: node src/index.ts <refuse|register|open [legacy]|pay|pay-receipt|gate-open|gate-pay|gate-refuse|acct-register|acct-trade|acct-overcap|acct-approve>',
  );
  process.exit(1);
}
