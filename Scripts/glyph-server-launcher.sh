#!/bin/zsh
# Starts the Glyph server for the LaunchAgent.
#
#   Scripts/glyph-server-launcher.sh <folder-to-serve> [--port=4321]
#
# This exists for one reason: to find node at RUN time rather than baking a path
# into the plist. On this machine node lives under nvm, at a path that carries
# the version number:
#
#   /Users/…/.nvm/versions/node/v24.16.0/bin/node
#
# The next `nvm install` changes that path, the plist would point at a node that
# no longer exists, and the server would simply stop coming back after a reboot —
# with nothing on screen to say why. Resolving it here survives node upgrades,
# and when node genuinely cannot be found this says so in the log instead of
# exiting silently.
#
# A LaunchAgent gets almost no environment: no PATH from the shell profile, no
# nvm. Every path below is therefore absolute or discovered.
emulate -L zsh
set -e

HERE=${0:A:h}
REPO=${HERE:h}
SERVE=${1:?usage: glyph-server-launcher.sh <folder-to-serve> [--port=NNNN]}
shift || true

find_node() {
  local nvm_dir=${NVM_DIR:-$HOME/.nvm}

  # 1. Whatever nvm calls default, so this follows `nvm alias default` and
  #    survives an upgrade — the whole point of the launcher. `default` rarely
  #    names a version directly: here it is "lts/*", which points at "lts/krypton",
  #    which points at the version. So follow the chain, with a bound in case a
  #    pair of aliases ever point at each other.
  # All declared up front: a bare `local` re-declaration inside the loop makes
  # zsh echo "match=''" onto stdout, and stdout here IS the resolved path.
  local want="" match="" newest="" p="" hop=0
  [[ -f "$nvm_dir/alias/default" ]] && want=$(<"$nvm_dir/alias/default")
  while [[ -n "$want" && $hop -lt 5 ]]; do
    want=${want%%[[:space:]]#}
    [[ -x "$nvm_dir/versions/node/$want/bin/node" ]] && {
      print -r -- "$nvm_dir/versions/node/$want/bin/node"; return 0
    }
    # A partial version ("24", "v24") — take the newest matching install.
    match=$(print -rl -- "$nvm_dir"/versions/node/v${want#v}*/bin/node(N) | sort -V | tail -1)
    [[ -n "$match" && -x "$match" ]] && { print -r -- "$match"; return 0 }
    # Otherwise it is another alias; follow it.
    [[ -f "$nvm_dir/alias/$want" ]] || break
    want=$(<"$nvm_dir/alias/$want")
    (( hop++ ))
  done
  # 2. The newest node nvm has, whatever it is.
  newest=$(print -rl -- "$nvm_dir"/versions/node/*/bin/node(N) | sort -V | tail -1)
  if [[ -n "$newest" && -x "$newest" ]]; then print -r -- "$newest"; return 0; fi
  # 3. The usual system locations.
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$p" ]] && { print -r -- "$p"; return 0 }
  done
  return 1
}

NODE=$(find_node) || {
  print -u2 -- "glyph-server: cannot find node."
  print -u2 -- "  Looked under ${NVM_DIR:-$HOME/.nvm}/versions/node, /opt/homebrew/bin,"
  print -u2 -- "  /usr/local/bin and /usr/bin. Install node, or run:  nvm alias default node"
  exit 78   # EX_CONFIG: configuration error, not a crash to retry forever
}

if [[ ! -d "$SERVE" ]]; then
  print -u2 -- "glyph-server: the folder to serve does not exist: $SERVE"
  exit 78
fi

print -r -- "glyph-server: $(date '+%Y-%m-%d %H:%M:%S') starting with $NODE"
exec "$NODE" "$REPO/server/glyph-server.mjs" "$SERVE" "$@"
