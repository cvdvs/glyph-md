#!/usr/bin/env python3
"""Compose a standalone page from the viewer and a markdown file.

    python3 Scripts/make-preview.py note.md out.html            # preview, as the app renders it
    python3 Scripts/make-preview.py note.md out.html --chrome   # standalone app: tabs, toolbar, open/save

The default output is byte-identical to what the macOS app loads, which is what
the CLAUDE.md workflow and the test harnesses rely on.
"""
import json
import pathlib
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

initial = "window.__initial = " + json.dumps(sample) + ";"
if chrome:
    initial = (
        "window.__glyphChrome = true;\n"
        + "window.__initialName = " + json.dumps(src.name) + ";\n"
        + initial
    )

out = html.replace("/*__MARKED_JS__*/", marked).replace("/*__INITIAL__*/", initial)
pathlib.Path(args[1]).write_text(out, encoding="utf-8", newline="")
print("wrote", args[1], "(chrome)" if chrome else "")
