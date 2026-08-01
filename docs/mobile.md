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

Open that link **once** on your phone. It stores the token and drops it from the
address bar; after that the phone is paired until you clear the browser's
storage. You land on the list of `.md` files in the folder — tap one to read or
edit it.

Node standard library only, nothing to install. `--port=NNNN` changes the port.

## What is safe, and what to avoid

- **Every request needs the token.** Without it the API answers 401. The token
  is random, lives in `~/.config/glyph/server-token` (readable only by you), and
  is stable across restarts so you pair once.
- **A request can never leave the served folder.** Every path is treated as a
  name inside the folder; `..`, absolute paths, and symlinks that point outside
  are all refused. `Scripts/server-smoke.mjs` is the test that proves it.
- **Only text files** are listed, read, and written — markdown plus `.txt`,
  `.text` and `.log`. A plain text file opens in the literal view and is saved
  byte for byte; the markdown renderer never touches it.
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
   account on both.
2. On the server, find its Tailscale address (`tailscale ip -4`, e.g.
   `100.x.y.z`), or use its Tailscale name.
3. On the phone, open `http://100.x.y.z:4321/#token=…` once.

That is all — the server itself does not change. It still only listens on your
own machine; Tailscale carries the connection privately between your devices.

## Keep it always on (macOS launchd)

So the server starts with the machine and restarts if it ever stops, create
`~/Library/LaunchAgents/com.glyph.server.plist` (adjust the two paths):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.glyph.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/Documents/Projects/App - Glyph/server/glyph-server.mjs</string>
    <string>/Users/YOU/Documents/drafts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/glyph-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/glyph-server.log</string>
</dict>
</plist>
```

Find your `node` path with `which node` and put it in place of
`/usr/local/bin/node`. Then:

```bash
launchctl load ~/Library/LaunchAgents/com.glyph.server.plist
```

The token is in the log (`/tmp/glyph-server.log`) or, unchanged, in
`~/.config/glyph/server-token`. To stop it: `launchctl unload …` the same file.
