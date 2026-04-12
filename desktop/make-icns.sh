#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PNG="$SCRIPT_DIR/icon.png"
SVG="$SCRIPT_DIR/icon.svg"
ICONSET="$SCRIPT_DIR/AppIcon.iconset"
ICNS="$SCRIPT_DIR/AppIcon.icns"
MASTER="$SCRIPT_DIR/_master.png"

if [ -f "$PNG" ]; then
  if command -v magick >/dev/null 2>&1; then
    magick "$PNG" -resize 1024x1024 -background none -gravity center -extent 1024x1024 "$MASTER"
  else
    cp "$PNG" "$MASTER"
  fi
elif [ -f "$SVG" ] && command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$MASTER"
elif [ -f "$SVG" ] && command -v qlmanage >/dev/null 2>&1; then
  qlmanage -t -s 1024 -o "$SCRIPT_DIR" "$SVG" >/dev/null 2>&1
  mv "$SCRIPT_DIR/icon.svg.png" "$MASTER"
else
  echo "Missing icon source. Provide either $PNG or $SVG."
  exit 1
fi

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

for size in 16 32 128 256 512; do
  double=$((size * 2))
  if command -v magick >/dev/null 2>&1; then
    magick "$MASTER" -resize "${size}x${size}" -background none -gravity center -extent "${size}x${size}" "PNG32:$ICONSET/icon_${size}x${size}.png"
    magick "$MASTER" -resize "${double}x${double}" -background none -gravity center -extent "${double}x${double}" "PNG32:$ICONSET/icon_${size}x${size}@2x.png"
  else
    sips -z "$size" "$size" "$MASTER" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$double" "$double" "$MASTER" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  fi
done

if iconutil --convert icns --output "$ICNS" "$ICONSET" >/dev/null 2>&1; then
  :
elif command -v python3 >/dev/null 2>&1 && python3 -c "import PIL" >/dev/null 2>&1; then
  python3 -c "from PIL import Image; img = Image.open('$MASTER'); img.save('$ICNS', sizes=[(16,16),(32,32),(64,64),(128,128),(256,256),(512,512),(1024,1024)])"
else
  echo "Failed to build $ICNS with iconutil, and no usable Pillow fallback was found."
  exit 1
fi

rm -rf "$ICONSET" "$MASTER"

echo "Created: $ICNS"
