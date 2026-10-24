#!/bin/bash
# shot_text.sh URL OUT "needle sentence" [width] : highlight the sentence in lime, crop its paragraph (plus the heading above it)
set -e
cd "$(dirname "$0")/.."
NEEDLE=$(printf '%s' "$3" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')
PREP="const needle=$NEEDLE;"'
const nz=s=>s.replace(/ /g," ").replace(/’/g,"\x27");
const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n,hit=null;
while((n=w.nextNode())){if(nz(n.nodeValue).includes(needle)){hit=n;break}}
if(!hit)throw new Error("needle not found");
const i=nz(hit.nodeValue).indexOf(needle);
const r=document.createRange();r.setStart(hit,i);r.setEnd(hit,i+needle.length);
const m=document.createElement("mark");m.id="sig-hl";
m.style.cssText="background:#d4ff00;color:#000;padding:2px 3px;border-radius:2px;box-decoration-break:clone";
r.surroundContents(m);return 1'
CLIP='(()=>{const p=document.getElementById("sig-hl").closest("p");const h=(()=>{let e=p.previousElementSibling;for(let k=0;k<8&&e;k++,e=e.previousElementSibling){if(/^H[1-6]$/.test(e.tagName))return e}return null})();const a=rect(p);if(!h||!HEAD)return a;const b=rect(h);return {x:Math.min(a.x,b.x),y:b.y,w:Math.max(a.w,b.w),h:a.y+a.h-b.y}})()'
CLIP=${CLIP/HEAD/${HEADING:-true}}
uv run --with websockets --with pillow python3 deck/capture.py "$1" "$2" --w "${4:-1200}" --h 900 --dpr 2 --wait 3 --prep "$PREP" --clip "$CLIP" --pad 16 --need "$3"
