#!/usr/bin/env bash
# Builds video/Signet-Demo.mp4: one narrated segment per beat in beats.tsv over the HD deck slide it names.
set -euo pipefail
cd "$(dirname "$0")"
VOICE="${VOICE:-en-US-AndrewMultilingualNeural}"
mkdir -p vo seg
: > list.txt
n=0
while IFS=$'\t' read -r slide text z cx cy; do
  n=$((n+1)); id=$(printf %02d $n)
  vo="vo/$id.mp3"
  [ -s "$vo" ] || uvx edge-tts --voice "$VOICE" --rate=+4% --text "$text" --write-media "$vo" </dev/null >/dev/null 2>&1
  a=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$vo")
  d=$(python3 -c "print(round($a + 0.6, 2))")
  frames=$(python3 -c "print(int($d * 30))")
  ffmpeg -y -v error -loop 1 -i "hd/s-$slide.png" -i "$vo" \
    -filter_complex "[0:v]scale=3840:2160,zoompan=z='1+(${z:-1.05}-1)*min(1,on/($frames*0.35))':x='iw*${cx:-0.5}*(1-1/zoom)/(1-1/${z:-1.05})*0+min(max(iw*${cx:-0.5}-iw/zoom/2,0),iw-iw/zoom)':y='min(max(ih*${cy:-0.5}-ih/zoom/2,0),ih-ih/zoom)':d=$frames:s=1920x1080:fps=30,fade=t=in:st=0:d=0.25,fade=t=out:st=$(python3 -c "print($d-0.25)"):d=0.25,format=yuv420p[v];[1:a]apad,atrim=0:$d,afade=t=out:st=$(python3 -c "print($d-0.2)"):d=0.2[a]" \
    -map "[v]" -map "[a]" -t "$d" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k -ar 48000 "seg/$id.mp4" </dev/null
  echo "file 'seg/$id.mp4'" >> list.txt
  echo "$id s$slide ${d}s"
done < beats.tsv
ffmpeg -y -v error -f concat -safe 0 -i list.txt -c copy Signet-Demo.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 Signet-Demo.mp4
