#!/bin/zsh
# Keeps the Glyph server running: starts it at login, restarts it if it stops.
#
#   Scripts/glyph-server-agent.sh install ~/Documents/Writing   # set it up
#   Scripts/glyph-server-agent.sh status                        # is it running?
#   Scripts/glyph-server-agent.sh logs                          # what did it say?
#   Scripts/glyph-server-agent.sh link                          # the phone link
#   Scripts/glyph-server-agent.sh uninstall                     # stop and remove
#
# It installs a LaunchAgent — a per-user background job, the same mechanism the
# other agents in ~/Library/LaunchAgents use. Nothing runs as root and nothing
# is installed system-wide; `uninstall` removes every trace.
emulate -L zsh
set -e

LABEL=com.glyph.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/glyph-server.log"
HERE=${0:A:h}
REPO=${HERE:h}
LAUNCHER="$REPO/Scripts/glyph-server-launcher.sh"
# Modern launchctl addresses a per-user job by domain, not by file path.
DOMAIN="gui/$(id -u)"

usage() { print -r -- "usage: $0 {install <folder> [--port=NNNN] | uninstall | status | logs | link | restart}"; exit 2; }

cmd=${1:-}; shift 2>/dev/null || true

case "$cmd" in

install)
  SERVE=${1:?which folder should be served? e.g. ~/Documents/Writing}
  SERVE=${SERVE:A}                      # absolute, symlinks resolved
  PORTARG=${2:-}
  [[ -d "$SERVE" ]] || { print -u2 -- "no such folder: $SERVE"; exit 1; }
  [[ -x "$LAUNCHER" ]] || { print -u2 -- "missing $LAUNCHER"; exit 1; }

  # macOS blocks background agents from Documents, Desktop and Downloads
  # OUTRIGHT — no prompt, no way for the agent to ask. Measured on macOS 26.5.2:
  # an agent could not even list ~/Documents. Installing here would produce a job
  # that fails every 30 seconds forever and looks, from the phone, like the
  # server is simply gone. So refuse up front and name the two things that work.
  # BOTH the served folder and this repo (which holds the launcher the agent
  # must execute) have to be readable by the agent. On this machine the repo
  # itself lives under ~/Documents, so the agent cannot even start the launcher —
  # exit code 127, "can't open input file". Check both.
  blocked=""
  case "$SERVE" in
    "$HOME"/Documents/*|"$HOME"/Documents|"$HOME"/Desktop/*|"$HOME"/Desktop|"$HOME"/Downloads/*|"$HOME"/Downloads)
      blocked="the folder you want to serve:\n\n    $SERVE" ;;
  esac
  case "$REPO" in
    "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*)
      blocked="Glyph itself, which the agent has to run:\n\n    $REPO" ;;
  esac
  case "$blocked" in
    ?*)
      print -u2 -- ""
      print -u2 -- "  macOS will not let a background agent read $(print -r -- "$blocked")"
      print -u2 -- ""
      print -u2 -- "  Documents, Desktop and Downloads are protected, and a launch agent"
      print -u2 -- "  cannot even ask for permission — it would just silently fail after"
      print -u2 -- "  every restart. Two things that DO work:"
      print -u2 -- ""
      print -u2 -- "  1. Double-click 'Scripts/Start Glyph Server.command' (keep it in your"
      print -u2 -- "     Dock). Terminal already has permission, so this needs nothing."
      print -u2 -- ""
      print -u2 -- "  2. Give this Mac's Terminal Full Disk Access, then re-run this — or"
      print -u2 -- "     serve a folder outside Documents, e.g. ~/Notes."
      print -u2 -- ""
      exit 1
      ;;
  esac

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  # Written with a heredoc rather than PlistBuddy so the whole thing is visible.
  # ProgramArguments is an ARRAY: each element is one argument, so a path with
  # spaces ("App - Glyph") needs no quoting and cannot be split.
  {
    print -r -- '<?xml version="1.0" encoding="UTF-8"?>'
    print -r -- '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    print -r -- '<plist version="1.0">'
    print -r -- '<dict>'
    print -r -- "  <key>Label</key><string>$LABEL</string>"
    print -r -- '  <key>ProgramArguments</key>'
    print -r -- '  <array>'
    print -r -- "    <string>$LAUNCHER</string>"
    print -r -- "    <string>$SERVE</string>"
    [[ -n "$PORTARG" ]] && print -r -- "    <string>$PORTARG</string>"
    print -r -- '  </array>'
    print -r -- '  <key>RunAtLoad</key><true/>'
    # Always bring it back: the point is that it is simply always there.
    print -r -- '  <key>KeepAlive</key><true/>'
    # If it cannot start (node missing, folder gone) this bounds the retry to
    # once every 30s instead of a tight loop, and the reason lands in the log.
    print -r -- '  <key>ThrottleInterval</key><integer>30</integer>'
    print -r -- "  <key>StandardOutPath</key><string>$LOG</string>"
    print -r -- "  <key>StandardErrorPath</key><string>$LOG</string>"
    print -r -- "  <key>WorkingDirectory</key><string>$REPO</string>"
    print -r -- '  <key>ProcessType</key><string>Background</string>'
    print -r -- '</dict>'
    print -r -- '</plist>'
  } > "$PLIST"
  chmod 644 "$PLIST"

  # Replace any previous copy, then start it. bootout is allowed to fail when
  # nothing was loaded, which is why set -e is suspended around it.
  set +e
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  set -e
  launchctl bootstrap "$DOMAIN" "$PLIST"
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"

  sleep 2
  print -r -- "installed: $LABEL"
  print -r -- "serving:   $SERVE"
  print -r -- "log:       $LOG"
  print -r -- ""
  "$0" link || true
  ;;

uninstall)
  set +e
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
  set -e
  rm -f "$PLIST"
  print -r -- "removed $LABEL. The server is stopped and will not start again at login."
  print -r -- "(The log stays at $LOG — delete it if you like.)"
  ;;

status)
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    print -r -- "installed."
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null \
      | grep -E "^\s+(state|pid|last exit code|program) " | sed 's/^[[:space:]]*/  /'
  else
    print -r -- "not installed. Run:  $0 install ~/Documents/Writing"
  fi
  pgrep -fl "glyph-server.mjs" | sed 's/^/  running: /' || print -r -- "  (no server process)"
  ;;

logs)
  [[ -f "$LOG" ]] || { print -r -- "no log yet at $LOG"; exit 0; }
  tail -40 "$LOG"
  ;;

link)
  # The phone link, taken from the running server's own banner.
  if [[ -f "$LOG" ]]; then
    local url
    url=$(grep -oE 'http://[^ ]+#token=[a-f0-9]+' "$LOG" | tail -1)
    if [[ -n "$url" ]]; then
      print -r -- "Open this once on your phone:"
      print -r -- ""
      print -r -- "    $url"
      print -r -- ""
      exit 0
    fi
  fi
  print -r -- "No link in the log yet. Try:  $0 status"
  ;;

restart)
  launchctl kickstart -k "$DOMAIN/$LABEL"
  print -r -- "restarted."
  ;;

*) usage ;;
esac
