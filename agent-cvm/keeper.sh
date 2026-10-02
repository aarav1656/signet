#!/usr/bin/env bash
# Keeps the attested agent admitted on every client account in ACCOUNTS: when an account's agentExpiry()
# is within RENEW_WITHIN seconds, asks the CVM for a fresh quote over that account's attestNonce(head-1)
# and submits registerAgent(quote, refBlock). One CVM key serves all of them. The key and
# the measurement do not change while the CVM runs, so this only extends the expiry. A rebooted CVM
# carries a new measurement the owner has to approve first (npm run acct-register); this script
# never approves one.
#
# Installed copy runs from ~/.local/share/chiron-keeper (launchd cannot read ~/Desktop), with a
# chmod 600 .env there holding PRIVATE_KEY (any funded RHC key: registerAgent is permissionless) and CVM_URL.
set -uo pipefail
export PATH="$HOME/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f ./.env ] && { set -a; . ./.env; set +a; }

RPC="${RHC_RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
ACCOUNTS="${ACCOUNTS:-0x9c69A43F16E994Ce45e9EE896E2D01369b0Aaa6D 0xE1d7939105cF8B3670d6b4a0E15546C036e6c34c 0x06AAadCc83873775D8A72F42B912f57ab3dc2506}"
RENEW_WITHIN="${RENEW_WITHIN:-10800}"
log() { echo "$(date -u +%FT%TZ) $*"; }

renew() {
  local ACCOUNT=$1 expiry left q quote ref signer current tx hash status block after
  expiry=$(cast call "$ACCOUNT" "agentExpiry()(uint64)" --rpc-url "$RPC" | awk '{print $1}') || { log "FAIL $ACCOUNT: agentExpiry unreadable"; return 1; }
  left=$(( expiry - $(date +%s) ))
  if [ "$left" -gt "$RENEW_WITHIN" ]; then
    log "ok $ACCOUNT: agentExpiry $expiry, ${left}s left, renew window ${RENEW_WITHIN}s"
    return 0
  fi
  log "renewing $ACCOUNT: agentExpiry $expiry, ${left}s left"
  q=$(curl -sf -m 60 --retry 2 --retry-all-errors --retry-delay 5 -X POST "${CVM_URL:?CVM_URL is not set}/quote?account=$ACCOUNT") || { log "FAIL $ACCOUNT: CVM $CVM_URL/quote unreachable"; return 1; }
  quote=$(jq -r .quote <<<"$q")
  ref=$(jq -r '.refBlock["$bigint"]' <<<"$q")
  signer=$(jq -r .agent <<<"$q")
  current=$(cast call "$ACCOUNT" "agent()(address)" --rpc-url "$RPC")
  if [ "$(tr A-F a-f <<<"$signer")" != "$(tr A-F a-f <<<"$current")" ]; then
    log "note $ACCOUNT: CVM key $signer differs from agent() $current (CVM rebooted); its measurement must be approved"
  fi
  tx=$(cast send "$ACCOUNT" "registerAgent(bytes,uint256)" "$quote" "$ref" \
    --private-key "${PRIVATE_KEY:?PRIVATE_KEY is not set}" --rpc-url "$RPC" --json) || { log "FAIL $ACCOUNT: registerAgent send failed"; return 1; }
  hash=$(jq -r .transactionHash <<<"$tx")
  status=$(jq -r .status <<<"$tx")
  block=$(jq -r .blockNumber <<<"$tx")
  [ "$status" = "0x1" ] || { log "FAIL $ACCOUNT: registerAgent $hash status $status"; return 1; }
  after=$(cast call "$ACCOUNT" "agentExpiry()(uint64)" --rpc-url "$RPC" --block "$((block))" | awk '{print $1}')
  [ "$after" -gt "$expiry" ] || { log "FAIL $ACCOUNT: registerAgent $hash mined but agentExpiry $after did not move past $expiry"; return 1; }
  log "renewed $ACCOUNT: tx $hash block $((block)) agent $signer agentExpiry $expiry -> $after"
}

failed=0
for a in $ACCOUNTS; do renew "$a" || failed=1; done
exit $failed
