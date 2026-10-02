#!/usr/bin/env bash
# Keeps the attested agent admitted: when agentExpiry() is within RENEW_WITHIN seconds, asks the CVM
# for a fresh quote over attestNonce(head-1) and submits registerAgent(quote, refBlock). The key and
# the measurement do not change while the CVM runs, so this only extends the expiry. A rebooted CVM
# carries a new measurement the owner has to approve first (npm run acct-register); this script
# never approves one.
#
# Installed copy runs from ~/.local/share/chiron-keeper (launchd cannot read ~/Desktop), with a
# chmod 600 .env there holding PRIVATE_KEY (any funded RHC key: registerAgent is permissionless) and CVM_URL.
set -euo pipefail
export PATH="$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f ./.env ] && { set -a; . ./.env; set +a; }

RPC="${RHC_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
ACCOUNT="${ACCOUNT_ADDRESS:-0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D}"
RENEW_WITHIN="${RENEW_WITHIN:-10800}"
log() { echo "$(date -u +%FT%TZ) $*"; }

expiry=$(cast call "$ACCOUNT" "agentExpiry()(uint64)" --rpc-url "$RPC" | awk '{print $1}')
left=$(( expiry - $(date +%s) ))
if [ "$left" -gt "$RENEW_WITHIN" ]; then
  log "ok: agentExpiry $expiry, ${left}s left, renew window ${RENEW_WITHIN}s"
  exit 0
fi

log "renewing: agentExpiry $expiry, ${left}s left"
q=$(curl -sf -m 60 -X POST "${CVM_URL:?CVM_URL is not set}/quote") || { log "FAIL: CVM $CVM_URL/quote unreachable"; exit 1; }
quote=$(jq -r .quote <<<"$q")
ref=$(jq -r '.refBlock["$bigint"]' <<<"$q")
signer=$(jq -r .agent <<<"$q")
current=$(cast call "$ACCOUNT" "agent()(address)" --rpc-url "$RPC")
if [ "$(tr A-F a-f <<<"$signer")" != "$(tr A-F a-f <<<"$current")" ]; then
  log "note: CVM key $signer differs from agent() $current (CVM rebooted); its measurement must be approved"
fi

tx=$(cast send "$ACCOUNT" "registerAgent(bytes,uint256)" "$quote" "$ref" \
  --private-key "${PRIVATE_KEY:?PRIVATE_KEY is not set}" --rpc-url "$RPC" --json) || { log "FAIL: registerAgent send failed"; exit 1; }
hash=$(jq -r .transactionHash <<<"$tx")
status=$(jq -r .status <<<"$tx")
block=$(jq -r .blockNumber <<<"$tx")
[ "$status" = "0x1" ] || { log "FAIL: registerAgent $hash status $status"; exit 1; }
after=$(cast call "$ACCOUNT" "agentExpiry()(uint64)" --rpc-url "$RPC" --block "$((block))" | awk '{print $1}')
[ "$after" -gt "$expiry" ] || { log "FAIL: registerAgent $hash mined but agentExpiry $after did not move past $expiry"; exit 1; }
log "renewed: tx $hash block $((block)) agent $signer agentExpiry $expiry -> $after"
