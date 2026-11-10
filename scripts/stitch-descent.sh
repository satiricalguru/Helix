#!/usr/bin/env bash
#
# Stitch the four descent clips into one scroll-scrubbable film.
#
#   1. download the clips listed in the manifest
#   2. concatenate them into one continuous take
#   3. re-encode every frame as a keyframe so scrubbing is frame-accurate
#   4. render a 720p version for mobile
#   5. pull a poster frame for prefers-reduced-motion
#
# Usage: scripts/stitch-descent.sh [manifest.json]

set -euo pipefail

MANIFEST="${1:-site/public/video/manifest.json}"
OUT_DIR="$(dirname "$MANIFEST")"
WORK_DIR="$OUT_DIR/work"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

mkdir -p "$WORK_DIR"

# 1. download
i=0
while IFS=$'\t' read -r url; do
  i=$((i + 1))
  target="$WORK_DIR/clip$i.mp4"
  if [[ -s "$target" ]]; then
    echo "[stitch] clip$i already downloaded"
    continue
  fi
  echo "[stitch] downloading clip$i"
  curl -sSL --fail -o "$target" "$url"
done < <(jq -r '.clips[] | select(.status == "rendered") | .urls[0]' "$MANIFEST")

count=$(find "$WORK_DIR" -name 'clip*.mp4' | wc -l | tr -d ' ')
[[ "$count" -ge 1 ]] || { echo "[stitch] no rendered clips in $MANIFEST" >&2; exit 1; }

# 2. concatenate
list="$WORK_DIR/concat.txt"
: > "$list"
for f in "$WORK_DIR"/clip*.mp4; do
  # Re-encode each input to a uniform format first, otherwise the concat
  # demuxer rejects mismatched streams.
  echo "file '$f'" >> "$list"
done

echo "[stitch] concatenating $count clip(s)"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$list" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  "$WORK_DIR/descent-joined.mp4"

# 3. keyframe every frame so scrubbing is exact
echo "[stitch] re-encoding with a keyframe on every frame (-g 1)"
ffmpeg -y -hide_banner -loglevel error \
  -i "$WORK_DIR/descent-joined.mp4" \
  -g 1 -keyint_min 1 -sc_threshold 0 \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUT_DIR/descent.mp4"

# 4. the mobile version
echo "[stitch] rendering the 720p version"
ffmpeg -y -hide_banner -loglevel error \
  -i "$OUT_DIR/descent.mp4" \
  -vf scale=-2:720 -g 1 -keyint_min 1 -sc_threshold 0 \
  -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
  -movflags +faststart -an \
  "$OUT_DIR/descent-720.mp4"

# 5. the poster frame
echo "[stitch] pulling the poster frame"
ffmpeg -y -hide_banner -loglevel error \
  -ss 0.1 -i "$OUT_DIR/descent.mp4" -frames:v 1 -q:v 3 \
  "$OUT_DIR/poster.jpg"

# the total running time, for the site's scroll mapping
duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT_DIR/descent.mp4")
frames=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$OUT_DIR/descent.mp4")

jq --arg d "$duration" --arg f "$frames" \
  '.duration_seconds = ($d | tonumber) | .frame_count = ($f | tonumber) | .video = "descent.mp4" | .video_mobile = "descent-720.mp4" | .poster = "poster.jpg"' \
  "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"

echo "[stitch] done"
echo "  $OUT_DIR/descent.mp4      $(du -h "$OUT_DIR/descent.mp4" | cut -f1)  ${duration}s  ${frames} frames"
echo "  $OUT_DIR/descent-720.mp4  $(du -h "$OUT_DIR/descent-720.mp4" | cut -f1)"
echo "  $OUT_DIR/poster.jpg"
