# The Windows and Linux build

The Mac app is a real AppKit document app — `NSDocument`, window tabs, an
`NSTextView` for the raw editor. None of that exists on Windows or Linux, and
reimplementing it three times would mean three sets of bugs.

So the portable build is arranged the other way round. `Resources/viewer.html`
**is** the interface: the renderer, the WYSIWYG editing layer, the serializer,
and — behind `window.__glyphChrome` — a tab strip, a formatting toolbar, open
and save, and the raw markdown view. `shell/glyph.cc` is about 900 lines and
owns only what a web page cannot: the window, files on disk, and native dialogs.

That is why the same page also runs as a single self-contained HTML file in a
browser. Three hosts, one interface.

## What it is built on

[webview/webview](https://github.com/webview/webview) 0.12.0, MIT — one header
carrying all three platform backends: WebView2 on Windows, WebKitGTK on Linux,
WKWebView on macOS. It is committed at `shell/vendor/webview/webview.h` rather
than fetched, so a build never depends on the network and an upstream change
cannot arrive without a deliberate `Scripts/vendor-webview.sh` refresh.

The one thing not committed is Microsoft's WebView2 SDK header, which
`Scripts/fetch-webview2.ps1` downloads at a pinned version and verifies against
a recorded sha256 before use. Only headers — the library has a built-in loader,
so nothing is redistributed.

## Decisions that are not obvious

**The page is written to a temp file and navigated to; `set_html` is never
used.** Every backend passes a NULL base URL to `set_html`, so a note's relative
image paths would resolve to nothing. This was settled by reading the vendored
source, not by assuming.

**Each document's folder is handed to the page as `window.__glyphDocDir`.** The
shell loads one page and switches documents inside it, so a single `<base>`
element could not follow a tab switch to a note in a different folder — and the
Content-Security-Policy forbids one anyway. The sanitizer resolves relative
image paths against that folder for display and keeps the author's original path
in `data-local-src`, which the serializer prefers. Writing the absolute path back
would rewrite notes with paths that only work on the machine that opened them.

**The CSP nonce must be real base64.** A hand-written nonce is rejected and every
script in the page silently stops running — a failure that looks exactly like a
broken build, with nothing in any log. Measured while designing this.

**`webview_bind` works under the strict CSP.** Worth checking, because the
library bootstraps the bridge by *injecting* script: if the policy had blocked
it, the bridge would have been dead on arrival.

**The library's JSON reader never touches a document.** Its unescaper handles
seven escapes and then gives up on `\uXXXX`, and a failed parse returns an empty
string — which the shell would have written over the note. A note containing an
ESC, which is every ANSI colour code in pasted terminal output, was enough.
`shell/glyph_json.h` is Glyph's own decoder, and a failed decode refuses the save
rather than writing nothing. `Scripts/json-smoke.cc` is the test.

**Paths on Windows are UTF-8 and cross to UTF-16, never to a codepage.** The
ANSI Win32 functions take the machine's codepage, so a folder spelled with real
Romanian diacritics — or Cyrillic, Greek, CJK — would simply fail to open.

**WebView2's browser accelerator keys are turned off.** With them on, Ctrl+R
reloads the page and throws away every unsaved edit in every tab, silently, on a
keystroke people press by reflex.

## Proving it works

`--selftest` renders the real fixtures and runs the smoke, security and fidelity
suites *inside the real webview*, then compares the markdown the serializer
writes byte-for-byte against `Scripts/fixtures/golden-sample.md`, printing the
first differing line if it drifts. It also writes, reads back and removes a file
named in Romanian holding U+00A0, U+200B, U+2060 and an ESC, and requires it back
byte-exact.

CI runs this on `ubuntu-24.04` and `windows-2025` on every push, and both jobs
build *and* run — a job that only compiles proves nothing here, because every
interesting failure happens at runtime and looks like a blank window. On Windows
the step uses `Start-Process -Wait` and requires the log to actually contain the
verdict: PowerShell does not wait for a GUI-subsystem process, and the job once
went green having tested nothing at all.

Because the vendored header also has a Cocoa backend, `shell/build-portable.sh`
builds the same source on a Mac. That is useful for looking at the interface, and
proves nothing about WebView2 or WebKitGTK.

## Known limits

- **The macOS build of this shell is a preview, not the Mac app.** It has no
  native file dialogs — pass a file on the command line. The real Mac app is the
  AppKit one in `Sources/`.
- **Wikilink resolution is narrower than on macOS.** `GlyphVault` walks a vault
  and resolves `[[a note]]` anywhere inside it; the portable shell only finds a
  sibling of the current note. A target is still treated as a name and never a
  path, so a traversal cannot escape.
- **No file-change watching.** The Mac app reloads a note that changed on disk
  while it is open and clean; the portable shell does not yet.
- **No AppImage.** WebKitGTK cannot be bundled sanely, so an AppImage would
  promise portability it could not deliver. A `.deb` that depends on the system
  library is the honest packaging.
- **Neither binary is signed.** You build it yourself.
