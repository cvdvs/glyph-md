# CLAUDE.md — Glyph

Native Mac markdown reader/editor (Obsidian-style live preview for single files). Keep it simple and dependency-free; explain changes in plain language.

**Read first:** `README.md` (what it is, how it's built, dev workflow).

Rules for this project:

1. **The app is Objective-C on purpose** — it must keep building with `clang` and Apple's Command Line Tools alone (no Xcode, no Swift, no package manager). Don't port it.
2. **Build with `./build.sh`**, then reinstall: `rm -rf /Applications/Glyph.app && cp -R build/Glyph.app /Applications/` and re-run `lsregister -f /Applications/Glyph.app`. Quit a running Glyph before reinstalling.
3. **All visual/rendering/editing changes happen in `Resources/viewer.html`** — it's the entire UI. Verify with `python3 Scripts/make-preview.py sample.md <out.html>` in a browser (both color schemes) and with the headless WebKit harness (`Scripts/webkit-smoke.m`) before rebuilding the app.
4. **No new dependencies.** `marked.min.js` is vendored; the app must work offline and build with nothing but clang.
5. Keep `sample.md` in sync with what the viewer supports — it's the feature checklist.
6. **The formatted view is a live WYSIWYG editor.** `#md` is `contenteditable`; the serializer in `viewer.html` (`serializeDoc`/`serializeBlock`/`serializeInline`) converts the rendered DOM back to markdown and posts `{type:"source", text}` through the `glyph` WKScriptMessageHandler on a 600ms debounce (`glyphFlush` forces it; the native side flushes before save and before switching to raw mode). **The renderer and serializer are mirror images** — every element the renderer can produce, the serializer must reverse (unknown elements fall back to `outerHTML`). If you add a rendered feature, add its serialization, or edits will strip it from files.
7. **Invisible characters are a real hazard in `viewer.html`:** contenteditable produces non-breaking spaces (U+00A0) and the inline typing rules insert zero-width spaces (U+200B). All normalization regexes must use explicit escapes written as `\u00a0` and `\u200b` — literal invisible characters in source do not survive editing tools. If typing rules stop matching, search the file for a raw U+00A0 first.
8. **Typing rules must run deferred** (one `setTimeout(0)` after the input event) — running execCommand re-entrantly inside the input dispatch half-applies. The browser also sometimes nests a freshly created list inside the old paragraph; `convertToList` unwraps it and the serializer's block-in-paragraph path catches whatever slips through.
9. Native toolbar/menu formatting actions are dual-routed: raw mode edits the NSTextView, formatted mode calls `window.glyphToolbar('<cmd>')` in the page.
