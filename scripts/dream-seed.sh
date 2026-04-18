#!/usr/bin/env bash
# Dream Seed Script — Feed a text file into characters' dreams
#
# Usage:
#   ./scripts/dream-seed.sh <file> <target> [--dry-run]
#
# <file>    Path to .txt or .rtf file
# <target>  Character ID (pkd, mckenna, john, hiru, lain, wired-lain) or "all"
# --dry-run Print fragments without sending
#
# Examples:
#   ./scripts/dream-seed.sh book.txt pkd
#   ./scripts/dream-seed.sh book.rtf all
#   ./scripts/dream-seed.sh book.txt all --dry-run

set -e

FILE="$1"
TARGET="$2"
DRY_RUN="$3"

if [ -z "$FILE" ] || [ -z "$TARGET" ]; then
  echo "Usage: $0 <file.txt|file.rtf> <character_id|all> [--dry-run]"
  echo "Characters: pkd, mckenna, john, hiru, lain, wired-lain, all"
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE"
  exit 1
fi

# Server config
SERVER="${LAIN_SERVER:-198.211.116.5}"
TOKEN="${LAIN_INTERLINK_TOKEN:-}"

if [ -z "$TOKEN" ] && [ "$DRY_RUN" != "--dry-run" ]; then
  # Try loading from .env
  if [ -f .env ]; then
    TOKEN=$(grep '^LAIN_INTERLINK_TOKEN=' .env | cut -d= -f2-)
  fi
  if [ -z "$TOKEN" ]; then
    echo "Error: LAIN_INTERLINK_TOKEN not set. Export it or add to .env"
    exit 1
  fi
fi

# Port lookup (no associative arrays — bash 3 compatible)
get_port() {
  case "$1" in
    wired-lain) echo 3000 ;;
    lain)       echo 3001 ;;
    pkd)        echo 3003 ;;
    mckenna)    echo 3004 ;;
    john)       echo 3005 ;;
    hiru)       echo 3006 ;;
    *)          echo "" ;;
  esac
}

if [ "$TARGET" = "all" ]; then
  TARGETS="pkd mckenna john hiru"
else
  PORT=$(get_port "$TARGET")
  if [ -z "$PORT" ]; then
    echo "Error: Unknown character '$TARGET'"
    echo "Available: wired-lain, lain, pkd, mckenna, john, hiru, all"
    exit 1
  fi
  TARGETS="$TARGET"
fi

# Strip RTF to plain text, or just read txt
EXT="${FILE##*.}"
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE" "$FRAGDIR"/*; rmdir "$FRAGDIR" 2>/dev/null' EXIT

if [ "$EXT" = "rtf" ]; then
  if command -v textutil &>/dev/null; then
    textutil -convert txt -stdout "$FILE" > "$TMPFILE"
  else
    sed -e 's/\\par /\n/g' -e 's/\\[a-z]*[0-9]*//g' -e 's/[{}]//g' "$FILE" > "$TMPFILE"
  fi
else
  cp "$FILE" "$TMPFILE"
fi

# Strip Project Gutenberg header/footer if present
if grep -q '\*\*\* START OF' "$TMPFILE"; then
  sed -n '/\*\*\* START OF/,/\*\*\* END OF/p' "$TMPFILE" | sed '1d;$d' > "${TMPFILE}.stripped"
  mv "${TMPFILE}.stripped" "$TMPFILE"
fi

# Split into fragments using Python (more reliable than bash string handling)
FRAGDIR=$(mktemp -d)

python3 -c "
import sys, os

with open('$TMPFILE', 'r', encoding='utf-8', errors='replace') as f:
    text = f.read()

# Split on double newlines (paragraphs)
paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]

# Skip illustration markers and very short lines
paragraphs = [p for p in paragraphs if not p.startswith('[Illustration') and len(p) > 30]

# Accumulate into 400-1500 char fragments
fragments = []
current = ''
for para in paragraphs:
    # Collapse internal whitespace
    para = ' '.join(para.split())

    if current:
        candidate = current + ' ' + para
    else:
        candidate = para

    if len(candidate) >= 1500:
        if current:
            fragments.append(current)
        current = para
    else:
        current = candidate

    if len(current) >= 400:
        fragments.append(current)
        current = ''

if current and len(current) >= 100:
    fragments.append(current)

# Truncate any fragments over 1900 chars (endpoint limit is 2000)
fragments = [f[:1900] for f in fragments]

fragdir = '$FRAGDIR'
for i, frag in enumerate(fragments):
    with open(os.path.join(fragdir, f'{i:04d}.txt'), 'w') as out:
        out.write(frag)

print(len(fragments))
"

TOTAL=$(ls "$FRAGDIR" | wc -l | tr -d ' ')
echo "Extracted $TOTAL dream fragments from: $(basename "$FILE")"
echo "Targets: $TARGETS"
echo ""

if [ "$DRY_RUN" = "--dry-run" ]; then
  i=0
  for frag in "$FRAGDIR"/*.txt; do
    i=$((i + 1))
    SIZE=$(wc -c < "$frag" | tr -d ' ')
    echo "--- Fragment $i/$TOTAL ($SIZE chars) ---"
    head -c 200 "$frag"
    echo "..."
    echo ""
  done
  echo "(dry run — nothing sent)"
  exit 0
fi

# Send fragments as dream seeds
SENT=0
FAILED=0

for target in $TARGETS; do
  PORT=$(get_port "$target")
  echo "=== Seeding $target (port $PORT) ==="

  i=0
  for frag in "$FRAGDIR"/*.txt; do
    i=$((i + 1))
    FRAGMENT=$(cat "$frag")
    SIZE=${#FRAGMENT}

    # Escape for JSON
    JSON_CONTENT=$(printf '%s' "$FRAGMENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')

    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "http://$SERVER:$PORT/api/interlink/dream-seed" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"content\": $JSON_CONTENT, \"emotionalWeight\": 0.7}" \
      2>/dev/null)

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')

    if [ "$HTTP_CODE" = "200" ]; then
      SENT=$((SENT + 1))
      echo "  [$i/$TOTAL] sent ($SIZE chars)"
    else
      FAILED=$((FAILED + 1))
      echo "  [$i/$TOTAL] FAILED ($HTTP_CODE): $BODY"
    fi

    # Small delay to avoid overwhelming
    sleep 0.2
  done
done

echo ""
echo "Done. Sent: $SENT, Failed: $FAILED"
echo "Seeds will be consumed one per dream cycle (~every 2-4 hours)"
echo "At $TOTAL seeds, full absorption takes ~$((TOTAL * 3)) hours per character"
