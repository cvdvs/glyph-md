#!/bin/sh
# Builds the portable Glyph shell on Linux, or a preview of it on macOS.
#
#   shell/build-portable.sh              # build
#   shell/build-portable.sh --selftest   # build, then run the suites in it
#
# On Linux this is the real thing. On macOS it builds the SAME source against
# the vendored library's Cocoa backend, which is how the Windows/Linux interface
# can be looked at without a Windows or Linux machine - useful, but it proves
# nothing about WebView2 or WebKitGTK. That is what CI is for.
set -e
cd "$(dirname "$0")/.."

OUT=shell/build
mkdir -p "$OUT"

# The interface is compiled in, so it has to be regenerated whenever it changes.
# The script is strict about bytes: it refuses CRLF and mojibake rather than
# shipping a viewer.html that differs from the one macOS ships.
python3 Scripts/embed-resources.py shell/resources.h

CXX=${CXX:-c++}
COMMON="-std=c++17 -O2 -DWEBVIEW_STATIC -Ishell/vendor/webview -Ishell"

case "$(uname -s)" in
  Darwin)
    echo "building the macOS preview (Cocoa backend)"
    $CXX $COMMON -DWEBVIEW_COCOA shell/glyph.cc \
      -framework WebKit -framework Cocoa -o "$OUT/glyph"
    ;;
  Linux)
    # WebKitGTK ships under three names. 4.1 is the libsoup3 build and is what
    # current distributions carry; 4.0 is libsoup2 and is still on older ones.
    # They cannot both be linked, so the package is chosen here and PRINTED -
    # when a distribution-specific bug turns up, the first question is which one
    # this binary was built against.
    PKG=""
    for p in webkit2gtk-4.1 webkit2gtk-4.0 webkit2gtk-5.0; do
      if pkg-config --exists "$p" 2>/dev/null; then PKG="$p"; break; fi
    done
    if [ -z "$PKG" ]; then
      echo "No WebKitGTK development package found." >&2
      echo "  Debian/Ubuntu: sudo apt install libwebkit2gtk-4.1-dev build-essential" >&2
      echo "  Fedora:        sudo dnf install webkit2gtk4.1-devel gcc-c++" >&2
      echo "  Arch:          sudo pacman -S webkit2gtk-4.1 base-devel" >&2
      exit 1
    fi
    echo "building against $PKG"
    $CXX $COMMON -DWEBVIEW_GTK shell/glyph.cc \
      $(pkg-config --cflags --libs "$PKG" gtk+-3.0) -o "$OUT/glyph"
    ;;
  *)
    echo "Use shell/build-portable.ps1 on Windows." >&2
    exit 1
    ;;
esac

echo "built $OUT/glyph"

if [ "$1" = "--selftest" ]; then
  # WebKitGTK needs a display. In CI there is none, so the caller wraps this in
  # xvfb-run; here it is left to whatever the machine has.
  "$OUT/glyph" --selftest
fi
