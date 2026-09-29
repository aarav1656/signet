# receipt-verifier

Item E5 of `docs/judging/chiron.md`'s build list: a Stylus (Rust) contract that
verifies Phala's canonical Ed25519-signed ACI inference receipt onchain, so a
caller can refuse payment when the model actually served differs from the model
requested. `verifier/` (this repo's existing crate) proves an attested enclave
produced a key and measurement; this crate proves that enclave's aggregator
routed to the requested model on one specific call. The two compose; see
`solidity/IReceiptVerifier.sol`'s design note for how.

## Receipt format (cited, not invented)

Source: `github.com/Dstack-TEE/private-ai-gateway`, commit
`fea9d0ed37b1807edb418f2a8c2b4151c6d1fdb0` (fetched 2026-09-28).

- **Signing scheme.** The signed bytes are the receipt payload's JCS (RFC 8785)
  form with the `signature` member removed
  (`crates/aci-protocol/src/receipt.rs:9-14` `receipt_signing_input`; produced
  and signed at `src/aci/receipt.rs:443-444`). Because every member name is
  ASCII and every number is an integer (`crates/aci-protocol/src/digest.rs:34-44`,
  the ACI spec's Appendix A), JCS reduces to compact JSON with object keys sorted
  lexicographically, no float formatting, no UTF-16 collation to reproduce.
- **Algorithm.** Ed25519, not optional: `finalize()` rejects any receipt key
  whose `algo != ALGO_ED25519` (`src/aci/receipt.rs:421-425`), and the only key
  type the key-provider module exposes is `ed25519_dalek::VerifyingKey`
  (`src/aci/keys.rs:17,24`; `Cargo.toml:34`).
- **Both model fields are present.** Top-level `model` is "the model the client
  requested" (`src/aci/receipt.rs:140-144,179-181`). The `upstream.verified`
  event's `model_id` is "the model the upstream actually served"
  (`src/aci/receipt.rs:361-364,367-379` `set_upstream_verified_model_id`), plus
  a fail-closed `result` (`"verified"`/`"failed"`, default `Failed`,
  `:78-93`). `response.returned`'s `body_hash` is `"sha256:"+hex`
  (`:319-331`, format at `crates/aci-protocol/src/digest.rs:10-13`).

Conclusion: the format is Ed25519 over JCS bytes and carries both model fields.
The build proceeded as specced; nothing here was invented.

## `verify_receipt_core`

`src/lib.rs`: `verify_receipt_core(pubkey: &[u8;32], receipt_bytes: &[u8], signature: &[u8]) -> Option<VerifiedReceipt>`,
no_std, no full JSON library (`src/json.rs` is a ~200-line structural
scanner: skip/find over strings, objects, arrays and numbers, used only after
the Ed25519 signature already verified, so a malicious byte string can never
reach it, since the signature check enforces the bytes are exactly what the TEE
signed). The `#[public]` Stylus method `ReceiptVerifier::verify_receipt` wraps
it into the exact tuple shape: `(bool, requestedModelHash, servedModelHash, responseHash)`,
never reverting on a bad receipt (only on a call the ABI itself cannot decode).

Dependency: `ed25519-dalek = { version = "2", default-features = false }`; see
size notes below for why the default `fast` feature is dropped.

## Tests

`cargo test --lib`: 7 passed (6 `json` structural-scanner unit tests, 1
end-to-end `TestVM` test of the actual `#[public]` ABI method).
`cargo test --test vectors`: 9 passed. A real Ed25519 keypair generated with
`OsRng`, a receipt document built in Phala's exact JCS field order, signed,
then verified; plus negative vectors: wrong pubkey, tampered `model` field,
tampered `body_hash`, a genuine signature swapped onto a different receipt,
a receipt whose `upstream.verified` failed (no served model to trust),
malformed JSON, and a wrong-length signature: none panic, all return `None`.
One test (`model_substitution_is_visible_as_differing_hashes`) is the exact
failure item E5 targets: signature still verifies (the TEE signed whatever it
actually did), but `requested_model_hash != served_model_hash`.

## Size

`cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc`
(Stylus's own brotli-compressed deployment size, limit 24 KiB / 24576 bytes):

| Step | Contract size |
|---|---|
| `ed25519-dalek` default features (`fast` = `curve25519-dalek/precomputed-tables`) | 26.5 KB (26460 bytes), **over the limit** |
| Drop `fast` (no precomputed basepoint tables; scalar mult runs the non-table path) | **19.2 KB (19208 bytes)**, fits, 5.4 KB headroom |

`opt-level = "z"`, `lto = true`, `panic = "abort"`, `strip = true`,
`codegen-units = 1` were already set from the first commit (mirrors
`verifier/`'s profile). Dropping the precomputed-tables feature was the one
optimization needed; raw (uncompressed) `.wasm` went from 70548 to 62256
bytes over the same change. Trade-off: dropping `fast` means Ed25519
verification runs more scalar-multiplication steps at call time (more gas),
not a smaller attack surface or a correctness change: the same 9 tests above
pass identically with or without the feature.

`cargo stylus check` was run against the network (read-only gas/size
simulation); nothing was deployed, per instruction.
