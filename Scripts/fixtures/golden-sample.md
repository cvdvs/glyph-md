# Hello, Glyph

Your markdown reader. Files open as tabs at the top, like a browser or a PDF viewer — double-click more `.md` files and they line up in this window.

> [!tip] This page is the editor
> Click anywhere and type — bold stays bold, headings stay colored, and everything saves into the `.md` file as you go. The toolbar up top works on your selection, typing `## ` starts a heading, `**text**` bolds itself as you close it, checkboxes tick, table cells edit. **⌘-click** a link to open it. **⌘E** still opens the raw markdown when you want the plain text.

## Headings are color-coded

Each level has its own color, so long documents read like a map.

### Third level, teal

#### Fourth level, lavender

## Collapsible callouts

> [!important]- This one starts closed
> Click the title to open it. Write `> [!important]-` — the minus means collapsed, a plus means open but foldable.

> [!example]+ This one starts open
> Same idea, opposite default.

## Everything else

- **Bold**, *italic*, ~~strikethrough~~, ==highlights==, `inline code`
- [[Wikilinks]], and #tags like #design or #glyph pick their own colors
- Checklists:
    - [x] Tabs
    - [x] Formatting toolbar
    - [x] Collapsible callouts
    - [ ] Open your first real file

| Shortcut | Does |
| --- | --- |
| ⌘E | Toggle read / edit |
| ⌘B / ⌘I / ⌘K | Bold / italic / link |
| ⌘1 ⌘2 ⌘3 | Heading level |
| ⌘S / ⌘O / ⌘N | Save / open / new |

```css
/* Code blocks keep their shape */
.accent { color: #6944ff; }
```

> Quotes speak in violet now.

The picture button in the formatting bar copies an image next to this file and links it — images sitting beside the note just render, including `![[image.png]]` embeds.
