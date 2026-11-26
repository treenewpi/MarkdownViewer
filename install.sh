#!/usr/bin/env bash
# Install Markdown Viewer and make it the default .md handler.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/MarkdownViewer.app"
DEST="/Applications/MarkdownViewer.app"

[ -d "$APP" ] || { echo "MarkdownViewer.app not found next to this script" >&2; exit 1; }

rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSR" -f "$DEST"

swiftc -O -o /tmp/mdview-setdefault "$HERE/setdefault.swift" 2>/dev/null || true
[ -x /tmp/mdview-setdefault ] && /tmp/mdview-setdefault || true

echo "installed: $DEST"
