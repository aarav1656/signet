Claim: one real attestation bundle fetched live from Phala's `GET /v1/aci/attestation`
(NVIDIA P-384 GPU evidence chain and signature, then an Intel TDX quote) can be verified in a
Stylus (Rust) contract in one transaction under 10M gas, with WASM under 96KB, and a one-bit
flip in any signature, certificate, or report-data field reverting.

Verdict: split. REFUTED on the bundle's structure as described in assay.md. CONFIRMED on the
Stylus-verification mechanism for the evidence the endpoint actually returns.

- REFUTED (input shape): `GET /v1/aci/attestation` (`https://inference.phala.com/v1/aci/attestation?nonce=<64-hex>`)
  returns only an Intel TDX quote. There is no NVIDIA GPU evidence anywhere in the response
  and no P-384 anywhere in the quote: the quote's attestation key type is ECDSA-P256
  (`att_key_type == 2`), and the PCK certificate chain embedded in it is also P-256, not P-384.
  Two independently fetched bundles (`attestation_raw_20260926_1.json`,
  `attestation_raw_20260926_2.json`, fetched 2026-09-26T12:29:43Z, see `FETCH_DATE.txt`) confirm
  this; NVIDIA GPU attestation is a separate, manually provisioned flow documented at
  docs.phala.com/phala-cloud/confidential-ai/confidential-gpu/deploy-and-verify (rent a GPU TEE
  instance, run `nvidia-smi conf-compute` + nvtrust locally), not surfaced by this endpoint at all.
- CONFIRMED (mechanism, for what the endpoint does return): the Intel TDX quote's chain of trust
  verifies end to end, live, in a single Stylus transaction, on real testnet ETH, at 2,367,302
  gas, well under the 10M ceiling, in a 32.8KB WASM binary, well under the 96KB ceiling. Three
  independent one-bit-flip negative cases were sent as real transactions and all reverted.

## What is verified on-chain (5 checks, matching Phala-Network/dcap-qvl's own verify_impl)

1. PCK leaf certificate signature verifies under the intermediate CA's public key (ECDSA-P256).
2. Intermediate CA certificate signature verifies under Intel's SGX Root CA public key
   (hardcoded in the contract from the well-known, publicly published
   `Phala-Network/dcap-qvl/src/TrustedRootCA.der`; confirmed via `openssl x509` to be the same
   P-256 cert valid to 2049).
3. `qe_report` (384-byte SGX EnclaveReport) signature verifies under the PCK leaf's public key.
4. `qe_report.report_data[0:32] == SHA256(attestation_key || qe_auth_data)`, binding the
   ephemeral attestation key to the certificate chain.
5. The top-level ISV/quote signature (over the 632-byte header+TDReport10) verifies under that
   attestation key.

Not checked, on-chain or off: TCB Info and QE Identity policy checks (dcap-qvl `verify_impl`
steps 1, 2, 6, 8, 9, 10). These need Intel's live PCCS collateral (separately signed JSON
documents), which this endpoint does not return and which is not curl-fetchable the way the
quote itself is. This is exactly the "TDX collateral too big/unavailable" fallback assay.md
names, applied here to the collateral that is genuinely missing; the PCK chain and quote
signatures, which are the collateral that does exist, are fully verified.

## Off-chain reference proof (ground truth before writing Rust)

`reference_verify.py` (Python, `cryptography` lib) implements the same 5 checks against both
real fetched bundles.

```
$ python3 reference_verify.py
...
BUNDLE attestation_raw_20260926_1.json: ALL CHECKS PASSED (TDX quote chain, no NVIDIA evidence present)
BUNDLE attestation_raw_20260926_2.json: ALL CHECKS PASSED (TDX quote chain, no NVIDIA evidence present)
...
[OK] ISV signature bit flip correctly rejected: InvalidSignature
[OK] PCK certificate bit flip correctly rejected: InvalidSignature
[OK] report_data bit flip correctly rejected: AssertionError
Summary: ALL NEGATIVE CASES REJECTED
```

This fixed the exact byte offsets and signed scopes the Stylus contract needed (auth_data's
outer `cert_type` is actually 6, "QE Report Certification Data", nesting an inner `cert_type`
5, "concatenated PCK cert chain" -- dcap-qvl's own code documents this but assay.md and a naive
reading of the spec do not distinguish the two levels).

## Stylus contract (`rs/src/lib.rs`)

`verify(bytes calldata quote) -> address`, returning `keccak256(attestation_key)[12:32]` (the
"bound signer address" assay.md's claim asks for) on success, `Err(&'static [u8])` (a short
ASCII reason, becomes the revert data) on any structural or cryptographic failure. Uses `p256`
+ `sha2` (no_std) and a hand-written DER/TLV walker instead of `x509-cert`/`der` (dcap-qvl's own
Cargo.toml notes those cost ~37KB extra on wasm32, which would have blown past a meaningful
fraction of the 96KB budget for no functional gain here).

- `cargo test --lib`: 4/4 pass (real bundle verifies; 3 bit-flip negative cases each `Err`).
- `cargo stylus check --endpoint https://rpc.testnet.chain.robinhood.com`: contract size
  32.8 KB (32,788 bytes, 2 fragments), wasm data fee 0.000180 ETH.
- Deployed + activated, Robinhood Chain testnet 46630 (Arbitrum Sepolia has no funded key; same
  ArbOS/Stylus v3 as Arbitrum Sepolia):
  - contract `0x3d4479e06d5ca5dcd2dbd53e18ae77101a47e1f9`
  - deploy tx `0x52e71f425082da80aa5b1bc7cef9415aa3f30eab1aa11cf9e292a5229eba2f16`
  - activation tx `16c74171047c2bd920245bdb55567c3858401ebe6ec7d809b7418315ed75d73d`

## Measured: one real `verify()` transaction, real bundle

```
$ cast send 0x3d4479e06d5ca5dcd2dbd53e18ae77101a47e1f9 "verify(bytes)(address)" $QUOTE \
    --rpc-url https://rpc.testnet.chain.robinhood.com --private-key "$PRIVATE_KEY" --json
```
tx `0xb40f22c61a3fc13857d1dd419c204bcb1f789978e31f161514f118d22dff1f24`, `status: 0x1` (success),
receipt `gasUsed: 0x241f46` = 2,367,302 gas. Returned address
`0x0Cc275E4e4C6696040f6a53914424B45a3211023`, cross-checked independently in Python as
`keccak256(raw_attestation_key)[12:]` -- identical. This is a real transaction's receipt
`gasUsed`, not `eth_estimateGas`.

2,367,302 gas is under the 10M ceiling by a factor of ~4.2x.

## Negative case: three real reverting transactions

All three built by flipping one bit in the same real bundle used above, sent live (not
`eth_call`), each mined with `status: 0x0`:

| Mutation | offset (bytes into quote) | tx hash | gasUsed | revert data |
|---|---|---|---|---|
| ISV/quote signature | 641 | `0xd116e432197be76f2f688aa17ad4330d83417db232e128bb289710f78b4ebcd0` | 2,367,053 | `SignatureInvalid` |
| PCK certificate (leaf PEM body) | 1458 | `0x4edc2c69456d95eeca7adc471b0ad026eef245bb34a49aa4a3818fb2e1b7179c` | 858,105 | `SignatureInvalid` |
| report_data (TD report) | 578 | `0xa057d9c65112c58166958db761678537c666e85a584e71b5bd5d8ccf6eb8b519` | 2,367,076 | `SignatureInvalid` |

The certificate mutation fails cheaper because the cert-chain check runs before the report_data
and ISV-signature checks and the contract reverts at the first failure. Same three cases were
also confirmed via `cast call` first (raw output: `execution reverted, data:
"0x5369676e6174757265496e76616c6964"`, which decodes to the ASCII string `SignatureInvalid`),
so the check-that-can-fail property is proven both as a dry-run revert and as an actual mined,
gas-consuming transaction.

## Solidity baseline and ratio

assay.md cites Base's AWS-Nitro Solidity validation (~41.3M gas across 5 transactions,
blog.base.dev/making-aws-nitro-validation-feasible-onchain) as the Solidity comparison point.
That is not the right baseline for this mechanism: AWS Nitro attestation is a structurally
different problem (RSA/P-384 chain, different report format) from Intel TDX/DCAP quote
verification. The apt comparison is Automata Network's `automata-dcap-attestation`
(github.com/automata-network/automata-dcap-attestation), an audited (Trail of Bits Feb 2025,
OpenZeppelin Oct 2025) production Solidity DCAP quote verifier doing the exact same PCK-chain +
qe_report + ISV-signature job this spike measured: it reports ~4-5M gas on-chain (~4M with
the RIP-7212 P-256 precompile, ~5M without).

Ratio, measured Stylus gas vs. the apt Solidity baseline: 2,367,302 / ~4-5M is about 1.7x to
2.1x cheaper, not the >10x-order advantage the 41.3M figure would imply. Using assay.md's
originally cited (wrong-mechanism) 41.3M figure would overstate the advantage by roughly 10x;
that number is named here only as the less-apt citation, not used in the ratio.

## Caveat

- TCB Info / QE Identity policy checks are not done, on-chain or off (see "What is verified"
  above) -- this is a real gap in trust, not just an omission for the spike: it means the
  verifier proves "this chain and these signatures are internally consistent and chain to
  Intel's root," but not "the specific TCB level this device reports is not on Intel's revoked
  list." A product using this would need a separate path for that collateral.
- The claim's own premise (NVIDIA P-384 evidence combined with a TDX quote at this endpoint)
  does not hold; the measured mechanism covers TDX/P-256 only.
- Gas figure is for one quote from one specific device/TCB level; a different device's PCK chain
  depth (2 vs. 3 certs) or a different cert size could shift gas modestly, not order-of-magnitude,
  since the dominant cost is 3 ECDSA-P256 verifications plus DER parsing regardless of chain depth.
- RIP-7212 (the P-256 precompile that would make the Solidity comparison closer to 4M rather
  than 5M) was not confirmed present on Robinhood Chain testnet or checked for use by the Stylus
  `p256` crate; the Stylus number here is a pure-Rust software implementation, not
  precompile-accelerated, so the ~1.7-2.1x gap could narrow or widen depending on precompile
  availability on both sides.

## Blocks product

Two separate blockers, not one:

1. The input assumption is wrong: assay.md's core claim describes a bundle this endpoint does
   not produce. Before building a product around "verify what `/v1/aci/attestation` returns,"
   the product needs to either (a) scope down to TDX-only attestation (CPU/gateway trust, no GPU
   confidentiality claim), or (b) build the separate NVIDIA GPU attestation integration
   (provisioned instance + nvtrust), which is a materially different and heavier engineering
   task than parsing one HTTP response.
2. Even scoped to TDX-only, the Stylus cost advantage over the best available audited Solidity
   alternative is real but modest (under 2.2x), not the order-of-magnitude the 41.3M-gas
   citation in assay.md implies. A product pitch built on "10x+ cheaper than Solidity" for this
   specific mechanism is not supported by measurement; "verifiable in one tx under 10M gas,
   modestly cheaper than the audited Solidity alternative" is.
