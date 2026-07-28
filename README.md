# Glyph

A tiny native Mac app for reading and editing markdown — Obsidian's live preview, without the vault.

LLM workflows produce piles of `.md` files. Obsidian wants them moved into a vault before it treats them well; TextEdit shows you raw asterisks. Glyph is the missing middle: double-click any markdown file anywhere on disk and it opens instantly as a formatted, editable page.

<p>
  <img src="docs/screenshot-dark.png" width="49%" alt="Glyph in dark mode">
  <img src="docs/screenshot-light.png" width="49%" alt="Glyph in light mode">
</p>

## What it does

- **The formatted page is the editor.** Click anywhere and type — formatting stays rendered while the file updates underneath (a DOM→markdown serializer writes your edits back continuously). No modes to think about.
- **Markdown-as-you-type.** `## ` starts a heading, `- ` a list, `- [ ] ` a checkbox, `1. ` a numbered list, `> ` a quote; `**bold**`, `*italic*`, `==highlight==`, `~~strike~~`, and `` `code` `` convert as you close them.
- **Obsidian-flavored rendering:** callouts with icons and `-`/`+` fold markers, `[[wikilinks]]`, `#tags` (each picks its own color), YAML frontmatter as a Properties panel, `![[image]]` embeds, checklists, tables you can type into.
- **Color-coded hierarchy** — H1 rose, H2 gold, H3 teal, H4 lavender — so long documents read like a map. Dark and light themes follow the system.
- **Tabs.** Every file opens as a tab in one window, like a browser. Drag a tab out for a second window.
- **A formatting toolbar** above the page: undo/redo, headings, bold/italic/underline/strike/highlight, code, link, picture (copied next to the note so it travels with it), lists, checklist, quote, callout, table, code block, clear formatting.
- **⌘-click opens links** in your browser; plain click places the cursor. **⌘E** flips to the raw markdown text and back.
- Word count, find (⌘F in raw mode), autosave with macOS version history, and pasted markdown formats itself.

No Electron. The whole app is a few small source files; it compiles in seconds and launches instantly.

## Install

Build from source — needs only Apple's Command Line Tools (no Xcode):

```bash
git clone https://github.com/cvdvs/glyph-md.git
cd glyph-md
./build.sh
cp -R build/Glyph.app /Applications/
```

Open any `.md` with right-click → Open With → Glyph. To make Glyph the default app for markdown files:

```bash
clang -fobjc-arc Scripts/set-default-md.m -o /tmp/glyph-default -framework Cocoa -framework UniformTypeIdentifiers && /tmp/glyph-default
```

Requires macOS 13+. Uninstall by deleting `/Applications/Glyph.app`.

## Shortcuts

| Keys | Does |
| --- | --- |
| ⌘E | Toggle formatted / raw markdown |
| ⌘B / ⌘I / ⌘U / ⌘K | Bold / italic / underline / link |
| ⌘1 ⌘2 ⌘3 | Heading level |
| ⇧⌘X / ⇧⌘H | Strikethrough / highlight |
| ⇧⌘8 / ⇧⌘L | Bullet list / checklist |
| ⇧⌘I | Insert picture |
| ⌘S / ⌘O / ⌘N / ⌘W | Save / open / new / close tab |
| ⌘-click | Open a link |

## How it's built

Two layers, deliberately simple:

- **Native shell** — Objective-C + AppKit ([`Sources/`](Sources)): a document-based app providing the window, tabs, toolbar, raw-text editor, autosave, and Open Recent. Objective-C so the whole thing builds with `clang` and the stock SDK — no Xcode, no package manager, no dependencies to install.
- **The page** — one `WKWebView` rendering [`Resources/viewer.html`](Resources/viewer.html): the entire UI (CSS + JS) in a single file. [marked.js](https://github.com/markedjs/marked) (MIT, vendored) parses markdown; a custom layer adds the Obsidian extras; the editing layer makes the rendered DOM `contenteditable` and serializes it back to markdown as you type.

`sample.md` doubles as the feature checklist — open it in Glyph to see everything render.

### Developing

All visual and editing behavior lives in `Resources/viewer.html`. Preview changes without rebuilding:

```bash
python3 Scripts/make-preview.py sample.md /tmp/preview.html
```

and open that in a browser. `Scripts/webkit-smoke.m` is a headless WKWebView harness that renders a file, simulates typing, and checks the markdown round-trip — the same checks used while building this. Rebuild and reinstall with `./build.sh` + copy to `/Applications` (quit Glyph first).

## Honest limits

- Editing in the formatted view lightly normalizes a file's markdown on first edit (bullet markers, spacing) — content is preserved, formatting is tidied.
- Link URLs and frontmatter are edited in raw mode (⌘E).
- The app is unsigned — you build it yourself, so Gatekeeper has nothing to complain about.

## License

[MIT](LICENSE). Markdown parsing by [marked](https://github.com/markedjs/marked) (MIT). Built by [Claudia Vaduvescu](https://github.com/cvdvs) (GOODGLYPH), with Claude Code.
