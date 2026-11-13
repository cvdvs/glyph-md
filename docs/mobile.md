# Read and edit your notes from your phone

The desktop app opens one file at a time. The **Glyph server** turns a folder of
`.md` files on an always-on machine into something you can read and edit from a
phone browser — with every edit saving straight back to the file on that
machine.

There is one copy of each file, on the server. The phone is a live window into
it, not a second copy. So it is genuinely real-time, there is nothing to sync,
and there is no conflict to resolve — close the phone and the edit is already on
disk.

## Run it

On the machine that holds your notes (a Mac mini, a laptop that stays on):

```bash
node server/glyph-server.mjs ~/Documents/drafts
```

It prints something like:

```
  On your phone (same wifi), open this ONCE — it remembers the token:

      http://192.168.1.20:4321/#token=… 

  Or by name:  http://mac-mini.local:4321/#token=…
```

Open that link **once** on your phone. It stores the token and stays paired. You
land on a folder tree of the notes in that folder — tap one to read or edit it.

Keep the **whole** link (the part after `#` included) when you bookmark it or add
it to your home screen. The token is remembered per address, and a home-screen
app gets its own storage separate from the browser's, so the full link is what
lets the shortcut re-pair itself — including after a phone clears storage for a
site it has not seen in a week.

### Add it to your home screen

On iOS, Share → **Add to Home Screen**. It opens full-screen with its own icon,
with no browser chrome — the page ships the `apple-touch-icon` and web-app tags,
sizes its touch targets to 44pt, and pads the toolbar for the notch so nothing
hides under the status bar.

### Copying a note out

The copy button — third from the left in the toolbar — puts the **whole note on
the clipboard as markdown**, ready to paste into a message, an email or a chat
with an assistant. Not the flattened text a phone's own Copy would give you:
headings, bullets, bold and links all survive.

It has to work without `navigator.clipboard`, because that API only exists in a
*secure context* and the server is plain `http` on a LAN or Tailscale address —
measured, not assumed. The button falls back to the older copy command, which
works everywhere and has to run inside the tap itself.

Node standard library only, nothing to install. `--port=NNNN` changes the port.

## PDFs

Drop a PDF anywhere in the served folder and it appears in the file list. It opens
in a tab, every page, and pinch zoom works. Nothing needs restarting; open the side
menu and the list refreshes.

PDFs are read-only, and the server refuses to write one. Pages are pictures, so
text can't be selected and links can't be tapped. A password-protected PDF says so
rather than opening. Scanned PDFs work, including the JBIG2 and JPEG 2000 formats.

The reader is [PDF.js](https://mozilla.github.io/pdf.js/) and it runs on the phone,
so the computer never parses a PDF. It is used by the phone server only: the desktop
apps don't include it, and the Mac app reads PDFs through Apple's PDFKit instead.

If something goes wrong on the phone, it is reported to the computer's log
(`~/Library/Logs/glyph-server.log`, lines starting `glyph-phone:`), since a phone
has no console of its own.

## Books

EPUB books work the same way: drop one in the folder and it appears in the file
list. It opens in a tab, one chapter at a time, with Contents, footnotes you can
follow and come back from, and an **Aa** panel for size, font, spacing, margins,
alignment and page color. Your settings and your place in each book are remembered
on that device. Books are read-only. A copy-protected book says so rather than
opening.

## Voice

Talk instead of typing: record on the phone and the words arrive as text. The
recording goes to the Mac, which turns it into text with Whisper
(`mlx_whisper`, running on the Mac's own chip), so nothing leaves your devices.
A pause of a second and a half or more starts a new paragraph, and every
paragraph gets a capital letter and a full stop. English and Romanian are told
apart on their own, sentence by sentence, so a note that switches between them
keeps both; or you can pick one, which is about twice as fast. If nothing was
said it says so, rather than making words up.

What the Mac needs, once:

- Python with `mlx_whisper` installed, and `ffmpeg` (`brew install ffmpeg`).
- The model already downloaded: `mlx-community/whisper-large-v3-mlx`, about
  3 GB, in the usual Hugging Face cache. The server never downloads anything.
  (It used `whisper-large-v3-turbo` before, which is half the size and quicker
  but heard her own recordings clearly worse; `GLYPH_WHISPER_MODEL` brings it back.)

The server looks for Python in this order: `GLYPH_PYTHON`, the first line of
`~/.config/glyph/python`, `python3` on the PATH, then `/opt/homebrew/bin` and
`/usr/local/bin`. The first one that can import `mlx_whisper` is used. If none
can, voice is simply switched off and the phone does not offer it.
`GLYPH_WHISPER_MODEL` picks a different model.

Measured on the Mac mini (M4) with the full model: a few seconds for a short
note in a chosen language, and 20 seconds for 2 minutes of speech. Auto takes
roughly half as long as the recording (6 s for 14 s, 14 s for 29 s, 50 s for
2 minutes), because it listens to each stretch on its own to decide its
language. One note is transcribed at a time. A note gets two minutes plus its
own length, so a stuck job is still stopped and a long note is not. The model stays
loaded for 15 minutes after the last note, then quits to give its memory back.

The recording is saved to a private temporary file and deleted as soon as it
has been read. Neither the audio nor the words are ever written to a log.

### Comparing models on your own voice

Whisper does not learn a voice by itself, so the way to better dictation is to
try setups on real recordings and keep the one that hears you best. To keep
recordings for that, make the folder; delete it to stop:

```bash
mkdir -m 700 ~/.config/glyph/voice-samples
```

While it exists, each recording is kept there with what Glyph heard (both
0600), and only there: never in the notes folder, never in a log. Then:

```bash
"$(head -1 ~/.config/glyph/python)" Scripts/voice-compare.py
```

writes `comparison.html` beside the recordings: each one, then what each setup
heard and how long it took. The setups are the model Glyph uses now
(large-v3-turbo), the full `mlx-community/whisper-large-v3-mlx` (about 3 GB,
downloaded once), that model with a word list as a hint, and, only if
`~/.config/glyph/openai-key` exists, OpenAI's `whisper-1` and
`gpt-4o-transcribe`, which send the recordings to OpenAI. The word list is
`~/.config/glyph/voice-words.txt`, one name or term per line: the hint is
written in the language being spoken, Romanian with its diacritics.

### The microphone needs the HTTPS address

The phone only lets a page use the microphone on an `https://` address, so voice
does not work on the plain `http://` links. Tailscale gives the Mac an HTTPS
address on the tailnet, privately:

```bash
tailscale serve --bg --https=4322 http://127.0.0.1:4321
```

Then put that address (`https://<this-mac>.<your-tailnet>.ts.net:4322`) on the
first line of `~/.config/glyph/secure-origin`. The page reads it and offers to
move there. Pair once on that address too: the token is stored per address.

## What is safe, and what to avoid

- **Every request needs the token.** Without it the API answers 401. The token
  is random, lives in `~/.config/glyph/server-token` (readable only by you), and
  is stable across restarts so you pair once.
- **A request can never leave the served folder.** Every path is treated as a
  name inside the folder; `..`, absolute paths, and symlinks that point outside
  are all refused. `Scripts/server-smoke.mjs` is the test that proves it.
- **Only text files are written** — markdown plus `.txt`, `.text` and `.log`. A
  plain text file opens in the literal view and is saved byte for byte; the
  markdown renderer never touches it. PDFs and books are listed and read, never written.
- **Keep it on your home network.** It binds LAN-wide so the phone can reach it,
  which is fine behind a home router. **Do not port-forward it to the public
  internet** — it would be a file-editing endpoint open to the world.
- If two people (or you on the Mac and you on the phone) edit the *same* file at
  once, the second save is refused with a "changed on the computer" notice
  rather than overwriting the newer version. Reopen it to load the latest, or
  press Save to force your version.

## Away from home: Tailscale

To reach it from cellular or another network without exposing it publicly, put
both devices on [Tailscale](https://tailscale.com) — free, encrypted, and
private (only your own devices can connect).

1. Install Tailscale on the server machine and on the phone; sign in to the same
   account on both. (Different accounts create two separate tailnets: both
   devices say "Connected" and simply cannot see each other.)
2. Start the server — it prints the Tailscale link in its banner automatically.
3. On the phone, open that link once.

That is all; the server itself does not change, because it already listens on
every interface. Tailscale carries the connection privately between your own
devices, and nothing is exposed to the internet.

The phone stores the token **per address**, so pairing on the wifi link does not
pair the Tailscale one — open each link once.

## Keep it running

Two ways, depending on whether you want to think about it.

**One click, no setup.** Double-click `Scripts/Start Glyph Server.command` (drag
it to the Dock). The server runs as long as that Terminal window is open, and
closing the window is the off switch. Nothing to configure — Terminal already
holds the permission described below, so the server inherits it.

**Always on.** One command plus one permission, and it starts at login and
restarts itself if it ever stops:

```bash
Scripts/install-always-on.sh ~/Documents/drafts
```

That builds a small `Glyph Server.app` in `/Applications` and installs a
LaunchAgent. Then grant it Full Disk Access — **System Settings → Privacy &
Security → Full Disk Access → +** → pick **Glyph Server** — and run:

```bash
Scripts/install-always-on.sh --start
```

It verifies rather than assumes: it reports "Running", or prints the log and
names what is missing. `--status` and `--uninstall` do what they say.

### Why it needs that permission, and why the app is a compiled binary

macOS protects `~/Documents`, `~/Desktop` and `~/Downloads` behind user consent.
An app can ask with a dialog; a background job has no window, so it cannot ask
and macOS silently answers no. Measured on macOS 26.5.2: a LaunchAgent could not
list `~/Documents` at all, while `~/Music` and `/tmp` were fine. If both your
notes and Glyph live under `~/Documents`, the job fails with `can't open input
file` and retries forever — which from the phone looks exactly like the server
having vanished.

The fix is the app bundle, and one detail matters: **its executable is a compiled
program, not a shell script.** A Full Disk Access grant attaches to a signed
program. macOS runs a script by exec'ing `/bin/zsh` with the script as input, so
the process it sees is `/bin/zsh` — which has no grant and should not be given
one. With a script there, the grant had no effect whatsoever; with
`shell/glyph-server-stub.c` compiled in its place, the same grant worked
immediately.

The stub is deliberately frozen and about twenty lines: it does nothing but hand
off to `Scripts/glyph-server-launcher.sh`, which lives in the repo and can change
freely. Because the grant follows the stub's signature, keeping it unchanged
means Glyph can be updated without ever re-granting the permission.

The launcher resolves `node` at run time (following nvm's `default` alias, then
the newest install, then Homebrew and `/usr/local`) rather than baking a path
into the LaunchAgent, since an nvm path carries the version number and would
break at the next upgrade.

If you would rather not grant anything, the double-click route above needs no
permission at all.

## Is "not secure" a problem?

On the **Tailscale link**, no. Tailscale encrypts everything between your own
devices (WireGuard), so the traffic is protected even though the URL says
`http://`. The browser shows the warning because it only inspects the URL scheme
and cannot see the tunnel underneath.

On the **home-wifi link** (`192.168.…`, `mac-mini.local`) the warning is
accurate — that traffic is not encrypted, and anyone on the same wifi could read
it, including the token. The simple habit is to use the Tailscale link
everywhere, including at home.

Adding real HTTPS with `tailscale serve` (it needs HTTPS certificates enabled
for the tailnet) protects nothing that Tailscale is not already protecting, but
it is no longer only cosmetic: the phone's microphone works only on an `https`
page, so voice needs it (see **Voice** above). It changes the address, and the
phone stores the pairing token per address, so you pair once more.

## One setting worth changing

Tailscale node keys expire after about 180 days by default. When the Mac mini's
key expires it drops off the tailnet and nothing on the Mac looks wrong — the
phone simply stops reaching it. Turn expiry off for the Mac (not the phone) at
[login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines):
the **⋯** menu next to the machine, then **Disable key expiry**.
