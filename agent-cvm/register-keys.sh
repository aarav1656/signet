#!/bin/bash
# Re-registers Phala's gateway signer and receipt key (24h attestationValidity) on every Assay the
# product reads: Arbitrum Sepolia, Robinhood Chain testnet (testUSDG, the one AgentAccount checks)
# and Robinhood Chain testnet (Paxos USDG). Every pass runs even if an earlier one fails; the job
# exits non-zero if any pass failed. Installed at ~/.local/share/chiron-keeper/register.sh
# (launchd cannot read ~/Desktop); ARB_RPC_URL in that directory's .env overrides the Arbitrum RPC.
set -uo pipefail
NODE=/Users/kamal/.nvm/versions/node/v24.9.0/bin/node
KEEP="$HOME/.local/share/chiron-keeper"
LOG="$KEEP/register.log"
cd "$KEEP/agent"
set -a; . "$KEEP/.env"; set +a
RHC=https://rpc.testnet.chain.robinhood.com
failed=0

pass() {
  local label=$1; shift
  echo "---- $label $(date -u '+%Y-%m-%d %H:%M:%S') UTC ----" >> "$LOG"
  env "$@" "$NODE" --env-file-if-exists=../.env --env-file-if-exists=.env src/index.ts register >> "$LOG" 2>&1
  local rc=$?
  echo "exit=$rc" >> "$LOG"
  [ "$rc" -eq 0 ] || failed=1
}

pass "Arbitrum Sepolia" RPC_URL="${ARB_RPC_URL:-}"
pass "RH 46630" CHAIN_ID=46630 RPC_URL=$RHC ASSAY_ADDRESS=0x2176E7f20654C8747Fa37b3d96E1ACbf7Df55b5D
pass "RH 46630 USDG Assay" CHAIN_ID=46630 RPC_URL=$RHC ASSAY_ADDRESS=0xcF4a98E21D4180b32B9726ef3d0A550A69973f9d
echo "job exit=$failed" >> "$LOG"
exit $failed
