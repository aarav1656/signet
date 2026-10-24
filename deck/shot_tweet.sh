#!/bin/bash
# shot_tweet.sh USER ID OUT "text that must be on the page" [max_lines]
# Header + tweet text only (media, quote card, engagement dropped), text capped at max_lines whole lines.
set -e
cd "$(dirname "$0")/.."
PREP='const a=document.querySelector("article");const t=a.firstElementChild.firstElementChild.children[1];if(!t||!t.textContent.length)throw new Error("no text block");const lh=parseFloat(getComputedStyle(t).lineHeight)||24;t.style.maxHeight=(lh*'"${5:-6}"')+"px";t.style.overflow="hidden";t.id="sig-tt";return lh'
CLIP='(()=>{const a=rect(document.querySelector("article")),t=rect(document.getElementById("sig-tt"));return {x:a.x,y:a.y,w:a.w,h:t.y+t.h-a.y+6}})()'
uv run --with websockets --with pillow python3 deck/capture.py "https://x.com/$1/status/$2" "$3" --w 560 --h 1200 --dpr 2 --wait 5 --need "$4" --prep "$PREP" --clip "$CLIP" --pad 12
