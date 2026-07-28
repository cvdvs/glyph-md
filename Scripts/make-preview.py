#!/usr/bin/env python3
"""Compose a standalone page from the viewer and a markdown file.

    python3 Scripts/make-preview.py note.md out.html            # preview, as the app renders it
    python3 Scripts/make-preview.py note.md out.html --chrome   # standalone app: tabs, toolbar, open/save

The default output is byte-identical to what the macOS app loads, which is what
the CLAUDE.md workflow and the test harnesses rely on.
"""
import base64
import hashlib
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[1]
args = [a for a in sys.argv[1:] if not a.startswith("--")]
chrome = "--chrome" in sys.argv

if len(args) < 2:
    sys.exit(__doc__)

html = (root / "Resources" / "viewer.html").read_text(encoding="utf-8")
marked = (root / "Resources" / "marked.min.js").read_text(encoding="utf-8")
src = pathlib.Path(args[0])
sample = src.read_text(encoding="utf-8")

def embed(value):
    """JSON for embedding inside a <script> block.

    json.dumps does not escape "<", so a document containing "</script>" would
    close the block early and everything after it would be parsed as HTML — a
    markdown file could then run whatever it liked, without ever passing through
    the sanitizer. U+2028/U+2029 are escaped for older parsers that treat them as
    line terminators inside string literals.
    """
    return (json.dumps(value)
            .replace("<", "\\u003c")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


initial = "window.__initial = " + embed(sample) + ";"
if chrome:
    initial = (
        "window.__glyphChrome = true;\n"
        + "window.__initialName = " + embed(src.name) + ";\n"
        + initial
    )

out = html.replace("/*__MARKED_JS__*/", marked).replace("/*__INITIAL__*/", initial)

# The page carries a Content-Security-Policy so that a document which somehow
# gets past the sanitizer still cannot execute. A standalone file has no server
# and no per-load step, so the inline blocks are pinned by hash instead of by a
# nonce. Hashes are computed AFTER substitution, over exactly the bytes the
# browser will see between the tags.
def sha(text):
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "sha256-" + base64.b64encode(digest).decode("ascii")


out = out.replace(' nonce="/*__CSP_NONCE__*/"', "")
scripts = re.findall(r"<script>(.*?)</script>", out, re.S)
styles = re.findall(r"<style>(.*?)</style>", out, re.S)
out = out.replace("'/*__CSP_SCRIPT__*/'", " ".join("'" + sha(b) + "'" for b in scripts))
out = out.replace("'/*__CSP_STYLE__*/'", " ".join("'" + sha(b) + "'" for b in styles))
pathlib.Path(args[1]).write_text(out, encoding="utf-8", newline="")
print("wrote", args[1], "(chrome)" if chrome else "")
