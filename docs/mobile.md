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

The server runs as long as its Terminal window is open. Double-click
**`Scripts/Start Glyph Server.command`** (drag it to the Dock and it is one
click). Closing that window stops the server; that is the off switch.

**Why not a background job that starts itself?** Because macOS will not allow it.
A LaunchAgent is denied `~/Documents`, `~/Desktop` and `~/Downloads` outright —
measured on macOS 26.5.2, an agent could not even list the folder — and it cannot
prompt for permission the way an app can. With both the notes and Glyph itself
under `~/Documents`, launchd exits 127 (`can't open input file`) and then retries
forever, which from the phone looks exactly like the server having vanished.
`Scripts/glyph-server-agent.sh` therefore refuses to install in that situation
and says so, rather than leaving a job that silently never works.

The Terminal window inherits Terminal's own permission, which is why the
double-click approach works with no setup at all.

## Is "not secure" a problem?

On the **Tailscale link**, no. Tailscale encrypts everything between your own
devices (WireGuard), so the traffic is protected even though the URL says
`http://`. The browser shows the warning because it only inspects the URL scheme
and cannot see the tunnel underneath.

On the **home-wifi link** (`192.168.…`, `mac-mini.local`) the warning is
accurate — that traffic is not encrypted, and anyone on the same wifi could read
it, including the token. The simple habit is to use the Tailscale link
everywhere, including at home.

Adding real HTTPS with `tailscale serve` is possible (it needs HTTPS
certificates enabled for the tailnet) but it is cosmetic: it replaces a
misleading warning with a padlock and protects nothing that Tailscale is not
already protecting. It also changes the address, and the phone stores the
pairing token per address, so you would pair once more.

## One setting worth changing

Tailscale node keys expire after about 180 days by default. When the Mac mini's
key expires it drops off the tailnet and nothing on the Mac looks wrong — the
phone simply stops reaching it. Turn expiry off for the Mac (not the phone) at
[login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines):
the **⋯** menu next to the machine, then **Disable key expiry**.
