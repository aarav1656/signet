#!/usr/bin/env bash
# Deploy the unchanged Stylus Verifier (verifier/) and ReceiptVerifier (receipt-verifier/) to Robinhood
# Chain, then read each back. Testnet by default; mainnet with RHC_CHAIN_ID=4663 and the mainnet RPC.
#
#   PRIVATE_KEY_PATH=/path/to/file-with-hex-key contracts/script/rhc/deploy-stylus.sh
#   RHC_CHAIN_ID=4663 RHC_RPC_URL=https://rpc.mainnet.chain.robinhood.com PRIVATE_KEY_PATH=... contracts/script/rhc/deploy-stylus.sh
#   ESTIMATE=1 ...  prints `cargo stylus check` (activation data fee) and deploy gas estimates; sends nothing.
#
# The key is read by cargo-stylus from the file; this script never reads, prints or passes it.
# Read-back: code exists at each address, and Verifier.verify() on a stored Phala quote with a
# nonce the quote does not carry reverts (the WASM runs and checks the nonce binding).
set -euo pipefail
: "${PRIVATE_KEY_PATH:?set PRIVATE_KEY_PATH to a file holding the deployer key}"
RPC="${RHC_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
CHAIN="${RHC_CHAIN_ID:-46630}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/contracts/deployments"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1

[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN" ] || { echo "RPC is not chain $CHAIN"; exit 1; }

if [ "${ESTIMATE:-0}" = 1 ]; then
  for crate in verifier receipt-verifier; do
    echo "== $crate on chain $CHAIN" >&2
    (cd "$ROOT/$crate" && cargo stylus check --endpoint "$RPC" && \
      cargo stylus deploy --endpoint "$RPC" --private-key-path "$PRIVATE_KEY_PATH" --no-verify --estimate-gas) >&2
  done
  exit 0
fi

deploy() {
  local crate="$1" log="$OUT/$CHAIN-$1.log"
  (cd "$ROOT/$crate" && cargo stylus check --endpoint "$RPC" && \
    cargo stylus deploy --endpoint "$RPC" --private-key-path "$PRIVATE_KEY_PATH" --no-verify) 2>&1 | tee "$log" >&2
  local addr
  addr="$(sed $'s/\x1b\\[[0-9;]*m//g' "$log" | grep -Eio 'deployed code at address:? *0x[0-9a-f]{40}' | grep -Eio '0x[0-9a-f]{40}' | tail -1)"
  [ -n "$addr" ] || { echo "no deployed address in $log"; exit 1; }
  local size
  size="$(cast codesize "$addr" --rpc-url "$RPC")"
  [ "$size" -gt 0 ] || { echo "$crate: no code at $addr"; exit 1; }
  echo "$crate $addr codesize $size" >&2
  printf '%s' "$addr"
}

VERIFIER="${VERIFIER:-$(deploy verifier)}"
RECEIPT_VERIFIER="${RECEIPT_VERIFIER:-$(deploy receipt-verifier)}"

QUOTE="0x$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['intel_quote'])" "$ROOT/fixtures/legacy_report1.json")"
if cast call "$VERIFIER" "verify(bytes,bytes32)(address,bytes32)" "$QUOTE" 0x$(printf '%064d' 0) --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Verifier accepted a quote under a nonce it does not bind: do not use this deployment"; exit 1
fi
echo "Verifier read-back: verify() on a stored quote with a foreign nonce reverted, as it must"
cast call "$RECEIPT_VERIFIER" "verifyReceipt(bytes32,bytes,bytes)(bool,bytes32,bytes32,bytes32,bytes32)" \
  0x$(printf '%064d' 0) 0x 0x --rpc-url "$RPC"

echo "VERIFIER=$VERIFIER"
echo "RECEIPT_VERIFIER=$RECEIPT_VERIFIER"
