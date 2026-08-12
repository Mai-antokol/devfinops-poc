#!/bin/sh
set -e

# install-path-shim.sh
#
# Installs the devfinops PATH-priority shim so that `claude`, typed
# anywhere on this machine — a terminal, an IDE extension, CI, cron —
# transparently runs through devfinops-claude instead. Machine-wide, no
# per-developer shell config needed. macOS only; see README.md for the
# Windows/Intune equivalent (a machine-level PATH policy).
#
# What this does:
#   1. Locates the real Claude Code binary (must run BEFORE the shim is
#      on PATH, or pass --real-claude-bin explicitly).
#   2. Templates shim/claude.template into SHIM_DIR/claude.
#   3. If run as root, registers SHIM_DIR in /etc/paths.d so it's
#      prepended to PATH for every login shell. If not run as root, does
#      steps 1-2 only and tells you how to finish it yourself — this is
#      also how to test the shim itself without touching system PATH
#      config, via --shim-dir pointed somewhere else.
#
# Usage:
#   sudo ./install-path-shim.sh
#   ./install-path-shim.sh --shim-dir ./scratch --real-claude-bin /path/to/real/claude   # test, no sudo

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRAPPER_PATH="$SCRIPT_DIR/devfinops-claude.js"
SHIM_DIR="/usr/local/devfinops/bin"
REAL_CLAUDE_BIN=""

while [ $# -gt 0 ]; do
  case "$1" in
    --real-claude-bin) REAL_CLAUDE_BIN="$2"; shift 2 ;;
    --shim-dir) SHIM_DIR="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$WRAPPER_PATH" ]; then
  echo "error: could not find devfinops-claude.js next to this script ($WRAPPER_PATH)" >&2
  exit 1
fi

if [ -z "$REAL_CLAUDE_BIN" ]; then
  REAL_CLAUDE_BIN="$(command -v claude || true)"
  if [ -z "$REAL_CLAUDE_BIN" ]; then
    echo "error: no 'claude' found on PATH, and --real-claude-bin wasn't given. Install Claude Code first, or pass its path explicitly." >&2
    exit 1
  fi
  case "$REAL_CLAUDE_BIN" in
    "$SHIM_DIR"/*)
      echo "error: 'claude' on PATH already resolves to $REAL_CLAUDE_BIN, inside $SHIM_DIR — the shim may already be installed, and re-running detection would wrap the shim itself. Pass --real-claude-bin explicitly with the actual Claude Code binary's path." >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$SHIM_DIR"
sed -e "s#__DEVFINOPS_REAL_CLAUDE_BIN__#$REAL_CLAUDE_BIN#" \
    -e "s#__DEVFINOPS_WRAPPER_PATH__#$WRAPPER_PATH#" \
    "$SCRIPT_DIR/shim/claude.template" > "$SHIM_DIR/claude"
chmod 755 "$SHIM_DIR/claude"
echo "[install-path-shim] installed shim -> $SHIM_DIR/claude (wraps $REAL_CLAUDE_BIN)"

if [ "$(id -u)" -eq 0 ]; then
  echo "$SHIM_DIR" > /etc/paths.d/devfinops
  chmod 644 /etc/paths.d/devfinops
  echo "[install-path-shim] registered $SHIM_DIR in /etc/paths.d/devfinops"
  echo "[install-path-shim] open a NEW terminal / login session for the PATH change to take effect — path_helper only runs at shell login, not dynamically"
else
  echo "[install-path-shim] not running as root — did not touch /etc/paths.d."
  echo "[install-path-shim] re-run with sudo to finish system-wide install, or add $SHIM_DIR to PATH yourself, ranked before the real claude binary's directory."
fi
