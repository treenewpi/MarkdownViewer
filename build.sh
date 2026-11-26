#!/usr/bin/env bash
# Rebuild MarkdownViewer.app from source (macOS 12.0+ compatible, Universal when SDK supports x86_64).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/MarkdownViewer.app"
MIN_MACOS="${MIN_MACOS:-12.0}"

if [ -d "$HERE/viewer" ]; then
  VIEWER_SRC="$HERE/viewer"
elif [ -d "$HERE/../markdown-viewer" ]; then
  VIEWER_SRC="$HERE/../markdown-viewer"
else
  echo "viewer directory not found" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp -R "$VIEWER_SRC" "$APP/Contents/Resources/viewer"
rm -f "$APP/Contents/Resources/viewer/build.sh" "$APP/Contents/Resources/viewer/build-vendor.sh"
cp "$HERE/MarkdownViewer.icns" "$APP/Contents/Resources/"
cp "$HERE/Info.plist" "$APP/Contents/"

BIN="$APP/Contents/MacOS/MarkdownViewer"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

swiftc -O -target "arm64-apple-macos${MIN_MACOS}" \
  -o "$TMP_DIR/MarkdownViewer-arm64" "$HERE/main.swift" \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers

if swiftc -O -target "x86_64-apple-macos${MIN_MACOS}" \
  -o "$TMP_DIR/MarkdownViewer-x86_64" "$HERE/main.swift" \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers 2>/dev/null; then
  lipo -create "$TMP_DIR/MarkdownViewer-arm64" "$TMP_DIR/MarkdownViewer-x86_64" -output "$BIN"
else
  echo "note: x86_64 slice unavailable in current SDK; building arm64-only (macOS ${MIN_MACOS}+)" >&2
  cp "$TMP_DIR/MarkdownViewer-arm64" "$BIN"
fi
chmod +x "$BIN"

codesign --force --deep -s - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
echo "built: $APP (min macOS ${MIN_MACOS}, $(lipo -archs "$BIN"))"
