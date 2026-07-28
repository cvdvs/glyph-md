#!/bin/zsh
# Refreshes shell/vendor/webview/ from upstream at a pinned tag.
# Third-party code is never hand-edited — change WEBVIEW_TAG and re-run instead.
set -e
cd "$(dirname "$0")/.."

WEBVIEW_TAG="0.12.0"
WEBVIEW_REPO="https://github.com/webview/webview"

if [ -n "$(git status --porcelain shell/vendor 2>/dev/null)" ]; then
  echo "shell/vendor has uncommitted changes; commit or discard them first." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone --quiet --depth 1 --branch "$WEBVIEW_TAG" "$WEBVIEW_REPO" "$TMP/wv"
SHA=$(git -C "$TMP/wv" rev-parse HEAD)

mkdir -p shell/vendor/webview
cp "$TMP/wv/core/include/webview/webview.h" shell/vendor/webview/webview.h
cp "$TMP/wv/LICENSE" shell/vendor/webview/LICENSE

cat > shell/vendor/WEBVIEW-VERSION.txt <<TXT
upstream: $WEBVIEW_REPO
tag:      $WEBVIEW_TAG
commit:   $SHA
license:  MIT (see webview/LICENSE)
files:    core/include/webview/webview.h -> shell/vendor/webview/webview.h

Glyph depends on the public C API only, plus webview::detail::json_parse for
reading the payload of a bind() callback. If a future refresh removes that,
shell/glyph.cc needs its own JSON reader.
TXT

echo "vendored webview $WEBVIEW_TAG ($SHA)"
shasum -a 256 shell/vendor/webview/webview.h
