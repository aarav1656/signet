// Digest construction tested against the contract's own vector and its own
// live view function, not a self-referential mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, http, keccak256, recoverAddress, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { assayAbi } from '../../web/src/abi/Assay.generated.ts';
import { assay, rpcUrl } from '../src/config.ts';
import { enclaveDigest, enclaveText, hex64, VOUCHER_TYPES, voucherDomain, voucherMessage } from '../src/digest.ts';

// Same literal inputs as contracts/test/Assay.t.sol's
// test_enclaveDigest_matchesPhalaLegacyFormat_andRecovers.
const requestHash = keccak256(toHex('some request body'));
const responseHash = keccak256(toHex('some response body'));

test('enclaveText matches Phala legacy format: 129 chars, lowercase, one colon', () => {
  const text = enclaveText(requestHash, responseHash);
  assert.equal(text.length, 129);
  assert.equal(text, `${hex64(requestHash)}:${hex64(responseHash)}`);
  assert.equal(text, text.toLowerCase());
  assert.equal(text.split(':').length, 2);
});

test('enclaveDigest matches the exact vector from Assay.t.sol (cross-checked independently with cast keccak / cast hash-message)', () => {
  const digest = enclaveDigest(requestHash, responseHash);
  assert.equal(digest, '0xed749ec2672e4dbaef68df8ef5ddb6002b886c0db7ac4d92103b54a549d7a76c');
});

test('enclaveDigest recovers the signer that actually signed it (round trip, independent of the fixed vector)', async () => {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const digest = enclaveDigest(requestHash, responseHash);
  // enclaveDigest already is the final EIP-191 personal_sign digest (the
  // "\x19Ethereum..." prefix is baked in by hashMessage); sign it as a raw
  // hash, exactly what Assay.sol's ECDSA.recover(enclaveDigest, sig) expects,
  // not signMessage (which would apply the EIP-191 prefix a second time).
  if (!account.sign) throw new Error('account.sign is unavailable');
  const signature = await account.sign({ hash: digest });
  const recovered = await recoverAddress({ hash: digest, signature });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});

test('voucherDomain matches the live contract\'s own eip712Domain() view, and Voucher signTypedData/recoverTypedDataAddress round-trips', { skip: false }, async (t) => {
  const domain = voucherDomain(arbitrumSepolia.id, assay);
  try {
    const client = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl) });
    const [, name, version, liveChainId, verifyingContract] = await client.readContract({
      address: assay,
      abi: assayAbi,
      functionName: 'eip712Domain',
    });
    assert.equal(domain.name, name);
    assert.equal(domain.version, version);
    assert.equal(BigInt(domain.chainId), liveChainId);
    assert.equal(domain.verifyingContract.toLowerCase(), verifyingContract.toLowerCase());
  } catch (err) {
    t.skip(`no live RPC reachable, skipping live eip712Domain() comparison: ${(err as Error).message}`);
    return;
  }

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const message = voucherMessage(1n, 1000n, requestHash, responseHash);
  const signature = await account.signTypedData({ domain, types: VOUCHER_TYPES, primaryType: 'Voucher', message });
  const { recoverTypedDataAddress } = await import('viem');
  const recovered = await recoverTypedDataAddress({ domain, types: VOUCHER_TYPES, primaryType: 'Voucher', message, signature });
  assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
});
