#!/usr/bin/env bash
# Rebuild MarkdownViewer.app from source.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/MarkdownViewer.app"

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

swiftc -O -o "$APP/Contents/MacOS/MarkdownViewer" "$HERE/main.swift" \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers

codesign --force --deep -s - "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
echo "built: $APP"
