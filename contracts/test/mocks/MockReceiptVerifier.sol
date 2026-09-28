// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IReceiptVerifier} from "../../src/IReceiptVerifier.sol";

/// Test double for the Stylus Ed25519 receipt verifier, mirroring MockVerifier.sol's
/// established pattern in this repo. The real verifier's cryptography is proven by
/// receipt-verifier's own `cargo test --lib` (public-method round trip) and
/// `cargo test --test vectors` (9 real-Ed25519-keypair vectors, including the exact
/// model-substitution case) and `cargo test --test export_fixture` (the two vectors
/// this repo's Solidity tests hardcode from `fixtures/receipt_vectors.json`, so the
/// (requestedModelHash, servedModelHash, requestHash, responseHash) values below are not invented
/// in Solidity -- they are exactly what `verify_receipt_core` computed). No
/// pure-Solidity Ed25519 library is vendored in this repo's dependency tree
/// (`contracts/lib` has only openzeppelin-contracts and forge-std) and this repo's
/// own convention is already "mock the Stylus contract's crypto, test Assay.sol's
/// own logic against controlled outputs" (see MockVerifier.sol); this mock follows
/// that same convention rather than introducing new, unaudited Ed25519 Solidity code
/// on a money path.
contract MockReceiptVerifier is IReceiptVerifier {
    bool public nextOk;
    bytes32 public nextRequestedModelHash;
    bytes32 public nextServedModelHash;
    bytes32 public nextRequestHash;
    bytes32 public nextResponseHash;

    function setNext(
        bool ok_,
        bytes32 requestedModelHash_,
        bytes32 servedModelHash_,
        bytes32 requestHash_,
        bytes32 responseHash_
    ) external {
        nextOk = ok_;
        nextRequestedModelHash = requestedModelHash_;
        nextServedModelHash = servedModelHash_;
        nextRequestHash = requestHash_;
        nextResponseHash = responseHash_;
    }

    function verifyReceipt(bytes32, bytes calldata, bytes calldata)
        external
        view
        returns (bool ok, bytes32 requestedModelHash, bytes32 servedModelHash, bytes32 requestHash, bytes32 responseHash)
    {
        return (nextOk, nextRequestedModelHash, nextServedModelHash, nextRequestHash, nextResponseHash);
    }
}
