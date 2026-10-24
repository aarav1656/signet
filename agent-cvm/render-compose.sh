#!/usr/bin/env bash
# Renders the measured compose file from the template.
#
#   agent-cvm/render-compose.sh <image@sha256:digest> <strategy.json> [out.yml]
#
# The strategy file is read only to hash it: its text is never copied into the compose file. The
# printed digest is what an auditor compares with the STRATEGY_SHA256 line of the compose file
# and with the compose-hash dstack records in RTMR3.
set -euo pipefail
IMAGE="${1:?image pinned by digest, for example ttl.sh/name@sha256:<64 hex>}"
STRATEGY="${2:?path to the strategy file}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${3:-$HERE/docker-compose.yml}"

[[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "image must end in @sha256:<64 hex>; a tag does not pin the code" >&2; exit 1; }
[ -s "$STRATEGY" ] || { echo "strategy file is missing or empty" >&2; exit 1; }
HASH="$(openssl dgst -sha256 -r "$STRATEGY" | cut -d' ' -f1)"
[[ "$HASH" =~ ^[0-9a-f]{64}$ ]] || { echo "could not hash the strategy file" >&2; exit 1; }

sed -e "s|__IMAGE__|$IMAGE|" -e "s|__STRATEGY_SHA256__|$HASH|" "$HERE/docker-compose.template.yml" > "$OUT"
grep -q "__" "$OUT" && { echo "unfilled field left in $OUT" >&2; rm -f "$OUT"; exit 1; }
echo "STRATEGY_SHA256 $HASH"
echo "STRATEGY_B64 (sealed): base64 -i $STRATEGY"
