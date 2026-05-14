#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ELECTRON_DIR="$SCRIPT_DIR/electron"
APP_NAME="HAICO"
OUT_DIR="$PROJECT_DIR/dist/electron"
PLATFORM="darwin"
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
    mkdir -p "$dest/build"
    cp -R "$src/build/." "$dest/build/"
  fi

  if [ -d "$src/prebuilds" ]; then
    mkdir -p "$dest/prebuilds"
    cp -R "$src/prebuilds/." "$dest/prebuilds/"
  fi
}

prune_node_pty_artifacts() {
  local node_pty_dir="$1"
  local keep_prebuild="${PLATFORM}-${ARCH}"

  if [ ! -d "$node_pty_dir" ]; then
    return
  fi

  rm -rf \
    "$node_pty_dir/deps" \
    "$node_pty_dir/scripts" \
    "$node_pty_dir/src" \
    "$node_pty_dir/third_party" \
    "$node_pty_dir/typings" \
    "$node_pty_dir/binding.gyp"

  if [ -d "$node_pty_dir/prebuilds" ]; then
    find "$node_pty_dir/prebuilds" -mindepth 1 -maxdepth 1 ! -name "$keep_prebuild" -exec rm -rf {} +
  fi

  find "$node_pty_dir/lib" -type f \( -name "*.map" -o -name "*.test.js" \) -delete 2>/dev/null || true
}

prune_better_sqlite3_artifacts() {
  local sqlite_dir="$1"

  if [ ! -d "$sqlite_dir" ]; then
    return
  fi

  rm -rf \
    "$sqlite_dir/deps" \
    "$sqlite_dir/src" \
    "$sqlite_dir/binding.gyp"
}

prune_runtime_node_modules() {
  local node_modules_dir="$1"

  if [ ! -d "$node_modules_dir" ]; then
    return
  fi

  prune_node_pty_artifacts "$node_modules_dir/node-pty"
  prune_better_sqlite3_artifacts "$node_modules_dir/better-sqlite3"

  rm -rf \
    "$node_modules_dir/@vscode" \
    "$node_modules_dir/codepage" \
    "$node_modules_dir/docx-preview" \
    "$node_modules_dir/jszip" \
    "$node_modules_dir/marked" \
    "$node_modules_dir/xlsx"

  find "$node_modules_dir" -type d \
    \( -name ".github" -o -name "docs" -o -name "doc" -o -name "example" -o -name "examples" \
    -o -name "test" -o -name "tests" -o -name "__tests__" -o -name "benchmark" -o -name "benchmarks" \) \
    -prune -exec rm -rf {} + 2>/dev/null || true

  find "$node_modules_dir" -type f \
    \( -name "*.map" -o -name "*.md" -o -name "*.markdown" -o -name "CHANGELOG*" -o -name "changelog*" \
    -o -name "*.tsbuildinfo" -o -name "*.tgz" -o -name "*.pdb" \
    -o -name "*.d.ts" -o -name "*.d.cts" -o -name "*.d.mts" \) \
    -delete 2>/dev/null || true
}

prune_runtime_project_dist() {
  local project_dist_dir="$1"

  if [ ! -d "$project_dist_dir" ]; then
    return
  fi

  find "$project_dist_dir" -type f \
    \( -name "*.d.ts" -o -name "*.d.ts.map" -o -name "*.js.map" \) \
    -delete 2>/dev/null || true
}

strip_bundled_node_binary() {
  local node_binary="$1"

  if [ ! -f "$node_binary" ]; then
    return
  fi

  chmod +x "$node_binary"
  strip -x "$node_binary" 2>/dev/null || true
  if command -v codesign >/dev/null 2>&1; then
    codesign -f -s - "$node_binary" >/dev/null 2>&1 || true
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
prune_runtime_project_dist "$RESOURCES_DIR/project/dist"

echo "  Bundling node_modules (production only)..."
TEMP_MODULES="$(mktemp -d)"
cp "$PROJECT_DIR/package.json" "$TEMP_MODULES/package.json"
cp "$PROJECT_DIR/package-lock.json" "$TEMP_MODULES/package-lock.json" 2>/dev/null || true
cd "$TEMP_MODULES"
npm install --omit=dev --ignore-scripts 2>/dev/null
copy_native_artifacts "better-sqlite3"
copy_native_artifacts "node-pty"
prune_runtime_node_modules "$TEMP_MODULES/node_modules"
cp -R "$TEMP_MODULES/node_modules" "$RESOURCES_DIR/project/node_modules"
rm -rf "$TEMP_MODULES"

echo "  Bundling Node.js runtime..."
NODE_PATH="$(command -v node)"
NODE_VERSION="$(node -v)"
mkdir -p "$RESOURCES_DIR/project/node/bin"
cp "$NODE_PATH" "$RESOURCES_DIR/project/node/bin/node"
strip_bundled_node_binary "$RESOURCES_DIR/project/node/bin/node"
echo "  Node.js $NODE_VERSION bundled from $NODE_PATH"

cd "$ELECTRON_DIR"

echo "  Running electron-packager..."
mkdir -p "$OUT_DIR"
TEMP_OUT_DIR="$(mktemp -d "$PROJECT_DIR/dist/electron-build.XXXXXX")"

ICON_FLAG=""
if [ -f "$SCRIPT_DIR/AppIcon.icns" ]; then
  ICON_FLAG="--icon=$SCRIPT_DIR/AppIcon.icns"
fi

npx electron-packager . "$APP_NAME" \
  --platform="$PLATFORM" \
  --arch="$ARCH" \
  --out="$TEMP_OUT_DIR" \
  --overwrite \
  --extra-resource="$RESOURCES_DIR/project" \
  $ICON_FLAG \
  --app-bundle-id=dev.haico.desktop \
  --ignore="_resources"

PACKED_APP="$(find "$TEMP_OUT_DIR" -maxdepth 2 -name "*.app" | head -1)"
if [ -z "$PACKED_APP" ]; then
  echo "ERROR: electron-packager did not produce an .app bundle"
  exit 1
fi

PACKED_ROOT="$(dirname "$PACKED_APP")"
FINAL_ROOT="$OUT_DIR/$(basename "$PACKED_ROOT")"
if [ -d "$FINAL_ROOT" ]; then
  rm -rf "$FINAL_ROOT"
fi
mv "$PACKED_ROOT" "$FINAL_ROOT"
PACKED_APP="$FINAL_ROOT/$(basename "$PACKED_APP")"
rmdir "$TEMP_OUT_DIR" 2>/dev/null || true

rm -rf "$RESOURCES_DIR"

APP_SIZE="$(du -sh "$PACKED_APP" | cut -f1)"
echo ""
echo "Built: $PACKED_APP ($APP_SIZE)"
echo ""
echo "To run: open \"$PACKED_APP\""
echo "To install: cp -r \"$PACKED_APP\" /Applications/"
