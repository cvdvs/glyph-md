#!/bin/zsh
# Builds Glyph.app into build/. Run ./build.sh, then copy build/Glyph.app to /Applications.
set -e
cd "$(dirname "$0")"

APP="build/Glyph.app"
ARCH=$(uname -m)

rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

clang -fobjc-arc -O2 \
  -target "$ARCH-apple-macos13.0" \
  Sources/main.m Sources/MarkdownDocument.m \
  Sources/GlyphTheme.m Sources/GlyphHighlighter.m Sources/GlyphGutter.m \
  -framework Cocoa -framework WebKit -framework UniformTypeIdentifiers \
  -o "$APP/Contents/MacOS/Glyph"

cp Info.plist "$APP/Contents/Info.plist"
cp Resources/viewer.html Resources/marked.min.js "$APP/Contents/Resources/"
if [ -f assets/glyph.icns ]; then
  cp assets/glyph.icns "$APP/Contents/Resources/glyph-md.icns"
fi

codesign --force --sign - "$APP"
echo "Built $APP"
