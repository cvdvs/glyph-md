#!/bin/zsh
# Double-click this to start the Glyph server, then read your notes on your phone.
#
# Keep it in the Dock (drag it there) and one click after a restart is all it
# takes. It runs in Terminal on purpose: Terminal already has permission to read
# your Documents folder, while a background launch agent does NOT — macOS blocks
# those from Documents entirely, with no prompt and no way to ask. Measured on
# this machine: a launch agent could not even list the folder.
#
# Closing the Terminal window stops the server.
emulate -L zsh
cd "${0:A:h:h}"

FOLDER="${GLYPH_FOLDER:-$HOME/Documents/Writing}"

clear
print -r -- ""
print -r -- "  Glyph — your notes on your phone"
print -r -- "  ────────────────────────────────"
print -r -- ""

if [[ ! -d "$FOLDER" ]]; then
  print -r -- "  Cannot find the folder to serve:"
  print -r -- "    $FOLDER"
  print -r -- ""
  print -r -- "  Edit this file and change FOLDER, or set GLYPH_FOLDER."
  print -r -- ""
  read -k1 "?  Press any key to close."
  exit 1
fi

# If one is already running, leave it alone. Killing it would take down whatever
# Terminal window is hosting it and leave a dead "[Process completed]" window
# behind, which is confusing and looks like a crash. To restart, close the window
# that is running it — closing that window IS how you stop the server.
if pgrep -f "glyph-server.mjs" >/dev/null 2>&1; then
  print -r -- "  It is already running — in another Terminal window."
  print -r -- ""
  print -r -- "  Look for a window titled 'Start Glyph Server.command'. The link is"
  print -r -- "  printed there. To restart, close that window first, then run this again."
  print -r -- ""
  read -k1 "?  Press any key to close this window."
  exit 0
fi

print -r -- "  Keep this window open — closing it stops the server."
print -r -- "  (You can minimise it.)"
print -r -- ""

exec ./Scripts/glyph-server-launcher.sh "$FOLDER"
