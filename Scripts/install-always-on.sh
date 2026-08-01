#!/bin/zsh
# Sets up "always on": the server starts at login and restarts if it stops.
#
#   Scripts/install-always-on.sh ~/Documents/Writing     # build + install
#   Scripts/install-always-on.sh --status                # is it working?
#   Scripts/install-always-on.sh --uninstall             # remove everything
#
# WHY THIS NEEDS A PERMISSION, and why it is shaped like this:
#
# macOS protects ~/Documents, ~/Desktop and ~/Downloads behind user consent. An
# APP can ask for that consent with a dialog; a background job has no window, so
# it cannot ask, and macOS silently answers no. Measured on macOS 26.5.2: an
# agent could not list ~/Documents at all, while ~/Music and /tmp were fine.
#
# So the background job is fronted by a tiny app bundle. The app is what gets the
# permission, and permission on a Mac is granted to an APP, not to a script.
#
# The app is a STUB that never changes: three lines that exec the launcher in the
# repo. That is deliberate. A Full Disk Access grant is tied to the signed app,
# so if the app itself were rewritten on every update the grant would be lost and
# she would have to re-grant it. Keeping the stub frozen means Glyph can be
# updated freely and the permission survives.
emulate -L zsh
set -e

HERE=${0:A:h}
REPO=${HERE:h}
# /Applications, not ~/Applications: the Full Disk Access file picker opens at
# /Applications and does not show the home one, so an app placed there is
# effectively invisible to the person trying to grant the permission.
APP="/Applications/Glyph Server.app"
EXE="$APP/Contents/MacOS/glyph-server"
LABEL=com.glyph.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/glyph-server.log"
DOMAIN="gui/$(id -u)"

say() { print -r -- "$@" }

case "${1:-}" in
--uninstall)
  set +e
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  set -e
  rm -f "$PLIST"
  rm -rf "$APP"
  say "Removed the launch agent and the Glyph Server app."
  say "You can also remove 'Glyph Server' from System Settings > Privacy &"
  say "Security > Full Disk Access, since nothing uses it now."
  exit 0
  ;;
--start)
  # Loading is a separate step from building on purpose: the Full Disk Access
  # grant has to exist first, or launchd starts a job that is denied the notes
  # and retries forever. This also VERIFIES rather than assuming — the whole
  # point of the exercise is that a silent failure looks like the server
  # vanishing, from a phone, with nothing on screen to explain it.
  [[ -x "$EXE" ]] || { say "Not built yet. Run:  $0 <folder-to-serve>"; exit 1; }
  [[ -f "$PLIST" ]] || { say "No launch agent. Run:  $0 <folder-to-serve>"; exit 1; }
  set +e
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  set -e
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  sleep 3

  if pgrep -f "glyph-server.mjs" >/dev/null; then
    say "Running. It will now start by itself after every restart."
    say ""
    tail -12 "$LOG" 2>/dev/null | sed 's/^/  /'
  else
    say "It did not start. The log says:"
    say ""
    tail -6 "$LOG" 2>/dev/null | sed 's/^/  /'
    say ""
    if tail -6 "$LOG" 2>/dev/null | grep -qi "can.t open input file\|Operation not permitted\|denied"; then
      say "  That is the permission. 'Glyph Server' needs Full Disk Access:"
      say "  System Settings > Privacy & Security > Full Disk Access > + >"
      say "  Cmd-Shift-G > ~/Applications > Glyph Server, switch ON."
      say "  Then run this again."
    fi
    exit 1
  fi
  exit 0
  ;;

--status)
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    say "launch agent: installed"
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
      | grep -E "^\s+(state|pid|last exit code) " | sed 's/^[[:space:]]*/  /'
  else
    say "launch agent: NOT installed"
  fi
  if pgrep -f "glyph-server.mjs" >/dev/null; then
    say "server: running"
  else
    say "server: not running"
  fi
  if [[ -f "$LOG" ]]; then
    say ""
    say "last few log lines:"
    tail -6 "$LOG" | sed 's/^/  /'
  fi
  exit 0
  ;;
esac

SERVE=${1:?usage: install-always-on.sh <folder-to-serve>}
SERVE=${SERVE:A}
[[ -d "$SERVE" ]] || { say "no such folder: $SERVE"; exit 1; }

# ---------------------------------------------------------------- the app
mkdir -p "$APP/Contents/MacOS" "$HOME/Library/Logs"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Glyph Server</string>
  <key>CFBundleDisplayName</key><string>Glyph Server</string>
  <key>CFBundleIdentifier</key><string>com.goodglyph.glyph-server</string>
  <key>CFBundleExecutable</key><string>glyph-server</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSDocumentsFolderUsageDescription</key><string>Glyph Server reads and saves the notes you asked it to serve to your phone.</string>
</dict></plist>
PLIST

# The stub is COMPILED, not a shell script. macOS attaches a Full Disk Access
# grant to a signed program, and a script is not one: launchd execs /bin/zsh with
# the script as input, so the process TCC sees is /bin/zsh, which has no grant.
# Measured — with a script here the grant had no effect at all. See
# shell/glyph-server-stub.c for the whole story.
cc -O2 -o "$EXE" "$REPO/shell/glyph-server-stub.c" || {
  say "could not compile the launcher stub ($REPO/shell/glyph-server-stub.c)"
  exit 1
}
chmod +x "$EXE"

# Ad-hoc signature: gives the bundle a stable identity for TCC without needing a
# developer account. The grant follows this signature, which is why the stub must
# not be rewritten afterwards.
codesign --force --sign - "$APP" >/dev/null 2>&1 || {
  say "warning: could not sign the app; the permission grant may not stick."
}

# ------------------------------------------------------------ the agent
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXE</string>
    <string>$SERVE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GLYPH_LAUNCHER</key><string>$REPO/Scripts/glyph-server-launcher.sh</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
chmod 644 "$PLIST"

say ""
say "  Built:  $APP"
say "  Agent:  $PLIST"
say "  Serving: $SERVE"
say ""
say "  ONE THING LEFT, and it has to be you — macOS will not let a program grant"
say "  itself this:"
say ""
say "    1. Open System Settings > Privacy & Security > Full Disk Access"
say "    2. Click +   (you will be asked for your Mac password)"
say "    3. Choose Glyph Server from the Applications list that opens"
say "    4. Choose 'Glyph Server', and make sure its switch is ON"
say ""
say "  Then run:   Scripts/install-always-on.sh --start"
say ""
