#!/bin/bash
# Rebuild the deck from the organisers' template, then render PDF and PNGs.
set -e
cd "$(dirname "$0")/.."
T=${SIGNET_TEMPLATE:-.progress/templates/1Ie2a-bHN_mYuqQ6TsX9ugGPA0N3DX374_RdADUsxwus.pptx}
uv run --with python-pptx python deck/build_deck.py "$T" deck/Signet-Deck.pptx
deck/render.sh
