#!/usr/bin/env bash
# Stamps the current package.json version onto the app icon.
# Requires ImageMagick: brew install imagemagick
# Safe to run multiple times — always reads from the .orig file.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON_DIR="$REPO_ROOT/ios/DarthPixit/Images.xcassets/AppIcon.appiconset"
ORIG="$ICON_DIR/App-Icon-1024x1024@1x.orig.png"
OUT="$ICON_DIR/App-Icon-1024x1024@1x.png"

if ! command -v convert &>/dev/null; then
  echo "⚠️  ImageMagick not found — icon will not be version-stamped."
  echo "   Install it with: brew install imagemagick"
  exit 0
fi

if [ ! -f "$ORIG" ]; then
  echo "❌ Original icon not found at $ORIG"
  exit 1
fi

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 'dev')"
echo "==> Stamping icon with v${VERSION}..."

# Draw a semi-transparent banner across the bottom third of the icon,
# then write the version in large white bold text centred over it.
convert "$ORIG" \
  \( -clone 0 -crop 1024x340+0+684 +repage \
     -fill '#00000099' -colorize 100 \) \
  -gravity South -composite \
  -fill white \
  -font Helvetica-Bold \
  -pointsize 160 \
  -gravity South \
  -annotate +0+90 "v$VERSION" \
  "$OUT"

echo "   Done → $OUT"
