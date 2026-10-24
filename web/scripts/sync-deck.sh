#!/usr/bin/env bash
# Copies the Demo Day deck and the two Founder House canvases from ../deck into web/public/deck,
# so the app serves them at /deck. Run after deck/make.sh or deck/canvas/build_canvas.py.
set -euo pipefail
cd "$(dirname "$0")/.."
src=../deck; out=public/deck
mkdir -p "$out/slides" "$out/canvas"
cp "$src/Signet-Deck.pdf" "$src/Signet-Deck.pptx" "$out/"
cp "$src"/png/slide-*.png "$out/slides/"
for f in Signet-Product-Canvas Signet-GTM-Canvas; do cp "$src/canvas/$f".{pdf,pptx,png} "$out/canvas/"; done
ls "$out/slides" | wc -l | xargs echo "slides:"
