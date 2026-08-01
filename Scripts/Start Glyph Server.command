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

# Stop an older copy so the port is free and there is only ever one.
pkill -f "glyph-server.mjs" 2>/dev/null
sleep 0.4

exec ./Scripts/glyph-server-launcher.sh "$FOLDER"
