#!/usr/bin/env python3
"""Compose a standalone preview of the viewer (same HTML the app renders).
Usage: python3 Scripts/make-preview.py <input.md> <output.html>"""
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[1]
html = (root / "Resources" / "viewer.html").read_text()
marked = (root / "Resources" / "marked.min.js").read_text()
sample = pathlib.Path(sys.argv[1]).read_text()

out = html.replace("/*__MARKED_JS__*/", marked)
out = out.replace("/*__INITIAL__*/", "window.__initial = " + json.dumps(sample) + ";")
pathlib.Path(sys.argv[2]).write_text(out)
print("wrote", sys.argv[2])
