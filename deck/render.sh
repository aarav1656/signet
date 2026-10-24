#!/bin/bash
# Renders Signet-Deck.pptx to PDF and per-slide PNGs with LibreOffice and the Urbanist static fonts.
set -e
cd "$(dirname "$0")"
mkdir -p /tmp/lo-prof/user/fonts
cp "$HOME"/Library/Fonts/Urbanist*static.ttf /tmp/lo-prof/user/fonts/ 2>/dev/null || true
soffice -env:UserInstallation=file:///tmp/lo-prof --headless --convert-to pdf Signet-Deck.pptx >/dev/null 2>&1
rm -rf png && mkdir png
pdftoppm -png -r 110 Signet-Deck.pdf png/slide
