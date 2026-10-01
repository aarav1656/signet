#!/usr/bin/env bash
# Builds and pushes the CVM agent image without a Docker daemon: crane appends one layer
# (agent sources, production node_modules, the generated addresses file) to the digest-pinned
# node base and sets the entrypoint. Prints the pushed image digest.
#
#   GH_TOKEN=... agent-cvm/build-image.sh ghcr.io/pranjalcodesinw3/chiron-agent:cvm1
#
# crane v0.22.1 (google/go-containerregistry), checksum-verified. node_modules is pure JS
# (viem, @noble/curves), so a layer built on macOS runs on linux/amd64 unchanged.
set -euo pipefail
IMAGE="${1:?image ref, for example ghcr.io/pranjalcodesinw3/chiron-agent:cvm1}"
BASE="docker.io/library/node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1"
CRANE="${CRANE:-crane}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/rootfs/app/agent" "$STAGE/rootfs/app/web/src/lib" "$STAGE/docker"
cp "$ROOT/agent/package.json" "$ROOT/agent/package-lock.json" "$STAGE/rootfs/app/agent/"
cp -R "$ROOT/agent/src" "$STAGE/rootfs/app/agent/src"
cp "$ROOT/web/src/lib/addresses.generated.ts" "$STAGE/rootfs/app/web/src/lib/"
(cd "$STAGE/rootfs/app/agent" && npm ci --omit=dev --ignore-scripts --silent)
rm -f "$STAGE"/rootfs/app/agent/node_modules/.package-lock.json
COPYFILE_DISABLE=1 tar --no-xattrs --no-acls --no-mac-metadata -C "$STAGE/rootfs" --uid 0 --gid 0 --numeric-owner -cf "$STAGE/layer.tar" app

export DOCKER_CONFIG="$STAGE/docker"
printf '%s' "$GH_TOKEN" | "$CRANE" auth login ghcr.io -u pranjalcodesinw3 --password-stdin >/dev/null
"$CRANE" append --platform linux/amd64 -b "$BASE" -f "$STAGE/layer.tar" -t "$IMAGE" >/dev/null
"$CRANE" mutate "$IMAGE" -w /app/agent --cmd node,src/cvm.ts --env NODE_ENV=production \
  -l org.opencontainers.image.source=https://github.com/pranjalcodesinw3/chiron -t "$IMAGE" >/dev/null
"$CRANE" digest "$IMAGE"
