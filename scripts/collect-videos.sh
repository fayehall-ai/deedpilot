#!/bin/bash
# Gather every finished briefing into one flat folder with readable names.
#
#   ./scripts/collect-videos.sh
#
# CAPE writes each package into its own directory alongside the per-section
# clips, stills and audio it built on the way — 121 mp4 files on disk for 16
# actual briefings. That layout is right for producing and wrong for sending:
# anyone opening the folder to attach a video has to know that the one worth
# having is the file whose name repeats its directory.
#
# This copies out only the finished briefings, named the way the frameworks are
# (County_State_Date), into artifacts/cape-videos. Re-runnable: it refreshes
# anything that has been re-produced since the last run and leaves the rest.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="artifacts/cape-videos"
mkdir -p "$OUT"

copied=0; fresh=0
while IFS= read -r -d '' src; do
  slug=$(basename "$src" .mp4)
  # <state>-<county-slug>-<YYYY-MM-DD>
  state=$(echo "$slug" | cut -d- -f1 | tr '[:lower:]' '[:upper:]')
  date=$(echo "$slug" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  county=$(echo "$slug" | sed -E "s/^[a-z]{2}-//; s/-[0-9]{4}-[0-9]{2}-[0-9]{2}$//" \
           | awk -F- '{for(i=1;i<=NF;i++){ $i=toupper(substr($i,1,1)) substr($i,2) } print}' OFS=_)
  dest="$OUT/${county}_County_${state}_${date}.mp4"

  if [ -f "$dest" ] && [ "$dest" -nt "$src" ]; then
    fresh=$((fresh+1))
  else
    cp "$src" "$dest"
    copied=$((copied+1))
  fi
done < <(find artifacts/cape -maxdepth 2 -name '*.mp4' ! -path '*/clips/*' -print0)

echo "$OUT — $copied copied, $fresh already current"
ls -l "$OUT"/*.mp4 | awk '{printf "  %5.1f MB  %s\n", $5/1048576, $9}' | sed "s|$OUT/||"
ls -l "$OUT"/*.mp4 | awk '{s+=$5; n++} END {printf "\n  %d videos, %.0f MB\n", n, s/1048576}'
