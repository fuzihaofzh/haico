#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ELECTRON_DIR="$SCRIPT_DIR/electron"
APP_NAME="HAICO"
OUT_DIR="$PROJECT_DIR/dist/electron"
ARCH="$(uname -m)"

if [ "$ARCH" = "x86_64" ]; then
  ARCH="x64"
elif [ "$ARCH" = "aarch64" ]; then
  ARCH="arm64"
fi

copy_native_artifacts() {
  local pkg="$1"
  local src="$PROJECT_DIR/node_modules/$pkg"
  local dest="$TEMP_MODULES/node_modules/$pkg"

  if [ ! -d "$src" ] || [ ! -d "$dest" ]; then
    return
  fi

  if [ -d "$src/build" ]; then
    mkdir -p "$dest"
    cp -R "$src/build" "$dest/build"
  fi

  if [ -d "$src/prebuilds" ]; then
    mkdir -p "$dest"
    cp -R "$src/prebuilds" "$dest/prebuilds"
  fi
}

echo "Building ${APP_NAME}.app (Electron)..."

echo "  Building HAICO server..."
cd "$PROJECT_DIR"
npm run build

echo "  Installing Electron dependencies..."
cd "$ELECTRON_DIR"
npm install

RESOURCES_DIR="$ELECTRON_DIR/_resources"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR/project"

echo "  Copying HAICO runtime files..."
mkdir -p "$RESOURCES_DIR/project/dist"
for entry in "$PROJECT_DIR"/dist/*; do
  if [ "$(basename "$entry")" = "electron" ]; then
    continue
  fi
  cp -R "$entry" "$RESOURCES_DIR/project/dist/"
done
cp -R "$PROJECT_DIR/public" "$RESOURCES_DIR/project/public"
cp -R "$PROJECT_DIR/bin" "$RESOURCES_DIR/project/bin"
cp "$PROJECT_DIR/package.json" "$RESOURCES_DIR/project/package.json"
cp "$PROJECT_DIR/package-lock.json" "$RESOURCES_DIR/project/package-lock.json" 2>/dev/null || true

echo "  Bundling node_modules (production only)..."
TEMP_MODULES="$(mktemp -d)"
cp "$PROJECT_DIR/package.json" "$TEMP_MODULES/package.json"
cp "$PROJECT_DIR/package-lock.json" "$TEMP_MODULES/package-lock.json" 2>/dev/null || true
cd "$TEMP_MODULES"
npm install --omit=dev --ignore-scripts 2>/dev/null
copy_native_artifacts "better-sqlite3"
copy_native_artifacts "node-pty"
cp -R "$TEMP_MODULES/node_modules" "$RESOURCES_DIR/project/node_modules"
rm -rf "$TEMP_MODULES"

echo "  Bundling Node.js runtime..."
NODE_PATH="$(command -v node)"
NODE_VERSION="$(node -v)"
mkdir -p "$RESOURCES_DIR/project/node/bin"
cp "$NODE_PATH" "$RESOURCES_DIR/project/node/bin/node"
echo "  Node.js $NODE_VERSION bundled from $NODE_PATH"

cd "$ELECTRON_DIR"

echo "  Running electron-packager..."
rm -rf "$OUT_DIR"

ICON_FLAG=""
if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
  ICON_FLAG="--icon=$SCRIPT_DIR/AppIcon.icns"
fi

npx electron-packager . "$APP_NAME" \
  --platform=darwin \
  --arch="$ARCH" \
  --out="$OUT_DIR" \
  --overwrite \
  --extra-resource="$RESOURCES_DIR/project" \
  $ICON_FLAG \
  --app-bundle-id=dev.haico.desktop \
  --ignore="_resources"

PACKED_APP="$(find "$OUT_DIR" -maxdepth 2 -name "*.app" | head -1)"
if [ -z "$PACKED_APP" ]; then
  echo "ERROR: electron-packager did not produce an .app bundle"
  exit 1
fi

rm -rf "$RESOURCES_DIR"

APP_SIZE="$(du -sh "$PACKED_APP" | cut -f1)"
echo ""
echo "Built: $PACKED_APP ($APP_SIZE)"
echo ""
echo "To run: open \"$PACKED_APP\""
echo "To install: cp -r \"$PACKED_APP\" /Applications/"
