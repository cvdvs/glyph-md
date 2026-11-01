#!/bin/zsh
# Runs Scripts/doc-smoke.m inside a copy of build/Glyph.app, so it gets the real
# Info.plist and the real page. Run ./build.sh first. An optional argument swaps in
# another viewer.html, which is how a bug is shown failing before it is fixed.
set -e
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Glyph Test.app"
cp -R build/Glyph.app "$APP"
# Its own identity. Under the real one, macOS shares this run's saved windows and
# recent files with the Glyph actually in use, and reopens test files inside it.
plutil -replace CFBundleIdentifier -string com.goodglyph.glyph.doc-smoke "$APP/Contents/Info.plist"
[ -n "$1" ] && cp "$1" "$APP/Contents/Resources/viewer.html"
clang -fobjc-arc -Wno-deprecated-declarations -Wno-undeclared-selector \
  -target "$(uname -m)-apple-macos13.0" \
  Scripts/doc-smoke.m Sources/MarkdownDocument.m Sources/GlyphPDFDocument.m Sources/GlyphBookDocument.m \
  Sources/GlyphTheme.m Sources/GlyphHighlighter.m Sources/GlyphGutter.m Sources/GlyphVault.m \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers -framework PDFKit \
  -o "$APP/Contents/MacOS/Glyph"
codesign --force --sign - "$APP" 2>/dev/null
"$APP/Contents/MacOS/Glyph"
