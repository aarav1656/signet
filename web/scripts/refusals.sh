#!/usr/bin/env bash
# Reproduces the two refusals the first screen shows, as eth_call simulations (nothing is broadcast).
# Needs cast, curl, jq. Public RPC, no key. Usage: web/scripts/refusals.sh
set -uo pipefail
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
RPC=${RHC_RPC:-https://rpc.testnet.chain.robinhood.com}
ACCT=0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D
STRANGER=0x000000000000000000000000000000000000dEaD
ZERO=0x0000000000000000000000000000000000000000
KEY="($ZERO,$ZERO,0,0,$ZERO)"
TRADE="($KEY,true,1,1,1)"

BLOCK=$(cast block-number --rpc-url "$RPC")
echo "block $BLOCK"

echo "1. execute() from an address with no attested key"
cast call "$ACCT" "execute(((address,address,uint24,int24,address),bool,uint128,uint128,uint64),(bytes32,bytes,bytes))" "$TRADE" \
  "(0x0000000000000000000000000000000000000000000000000000000000000000,0x,0x)" \
  --from "$STRANGER" --rpc-url "$RPC" 2>&1 | tail -n 2
echo "selector of NotAgent(): $(cast sig 'NotAgent()')"

echo "2. registerAgent() with a fresh Phala TDX quote bound to the account's attestNonce"
REF=$((BLOCK - 1))
NONCE=$(cast call "$ACCT" "attestNonce(uint256)(bytes32)" "$REF" --rpc-url "$RPC")
QUOTE=$(curl -sf "https://inference.phala.com/v1/attestation/report?nonce=${NONCE#0x}&signing_algo=ecdsa" | jq -r .intel_quote)
case "$QUOTE" in 0x*) ;; *) QUOTE="0x$QUOTE" ;; esac
echo "refBlock $REF nonce $NONCE quote ${#QUOTE} hex chars"
cast call "$ACCT" "registerAgent(bytes,uint256)" "$QUOTE" "$REF" --rpc-url "$RPC" 2>&1 | tail -n 2
echo "selector of MeasurementNotApproved(bytes32): $(cast sig 'MeasurementNotApproved(bytes32)')"
