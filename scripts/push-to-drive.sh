#!/bin/bash
# Push generated CAPE artifacts to the shared Drive folder.
#
#   ./scripts/push-to-drive.sh
#
# Puts county framework .docx files under CAPE/Framework and finished briefing
# videos under CAPE/Video. Re-runnable: rclone copies only what changed, so the
# weekly regeneration costs one command and uploads only the new documents.
#
# The remote is pinned to the CAPE folder by id rather than by path, so it works
# whether CAPE sits in the authorising account's My Drive or is shared into it.
#
# One-time setup, which must be done by someone who can WRITE to CAPE — the
# folder is owned by faye@thetaxdeedcollective.com:
#
#   rclone config create tdc drive \
#       scope=drive root_folder_id=1cbkH6Dcnaq8B4EN8UvyJVEn1e7BHUTKg
#
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE="${RCLONE_REMOTE:-tdc}"

if ! rclone listremotes 2>/dev/null | grep -q "^${REMOTE}:$"; then
  echo "No rclone remote named '${REMOTE}'. Run the one-time setup in this script's header." >&2
  exit 1
fi

echo "== Framework =="
rclone mkdir "${REMOTE}:Framework"
rclone copy artifacts/frameworks "${REMOTE}:Framework" \
  --include '*.docx' --progress --transfers 8 --checkers 16

echo
echo "== Video =="
# collect-videos.sh puts the finished briefings in one flat folder under names
# matching the frameworks, and leaves the per-section clips and stills behind —
# those are build intermediates with no business in a shared folder.
./scripts/collect-videos.sh >/dev/null
rclone mkdir "${REMOTE}:Video"
rclone copy artifacts/cape-videos "${REMOTE}:Video" \
  --include '*.mp4' --progress --transfers 4 --checkers 8

echo
echo "== Now in Drive =="
echo "Framework: $(rclone size "${REMOTE}:Framework" --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"{d[\"count\"]} files, {d[\"bytes\"]/1048576:.0f} MB")')"
echo "Video:     $(rclone size "${REMOTE}:Video" --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"{d[\"count\"]} files, {d[\"bytes\"]/1048576:.0f} MB")')"
