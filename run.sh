#!/usr/bin/env bash
# Contexy launcher.
#
#   ./run.sh                      desktop app (Electron)
#   ./run.sh server               server only, http://127.0.0.1:6161 — zero deps
#   ./run.sh server ~/code ~/work scan these roots instead of the defaults
#   ./run.sh dist                 build the macOS dmg/zip into ./dist
#   PORT=7000 ./run.sh            serve on another port
#
# Flags: --port N, --open (server mode: open a browser), --no-install.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

MODE=""
OPEN=0
INSTALL=1
ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    desktop|app|electron) MODE=desktop ;;
    server|web|serve)     MODE=server ;;
    dist|build|package)   MODE=dist ;;
    --port|-p)            PORT="${2:?--port needs a number}"; shift ;;
    --port=*)             PORT="${1#*=}" ;;
    --open|-o)            OPEN=1 ;;
    --no-install)         INSTALL=0 ;;
    -h|--help)            sed -n '2,10p' "$0" | cut -c3-; exit 0 ;;
    *)                    ARGS+=("$1") ;;
  esac
  shift
done

MODE="${MODE:-desktop}"
export PORT="${PORT:-6161}"

if ! command -v node >/dev/null 2>&1; then
  echo "run.sh: node is not on PATH — install Node 18+ (brew install node)" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "run.sh: node $(node -v) is too old — Contexy needs 18+" >&2
  exit 1
fi

install_deps() {
  [ "$INSTALL" -eq 1 ] || return 0
  [ -d node_modules ] && return 0
  echo "==> installing dependencies (electron ~90MB, first run only)"
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
}

case "$MODE" in
  server)
    # server.js has no dependencies — never pay for an npm install here.
    if [ "$OPEN" -eq 1 ]; then
      ( sleep 1; open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true ) &
    fi
    exec node server.js ${ARGS[@]+"${ARGS[@]}"}
    ;;
  desktop)
    install_deps
    exec npx --no-install electron . ${ARGS[@]+"${ARGS[@]}"}
    ;;
  dist)
    install_deps
    exec npx --no-install electron-builder --mac dmg zip dir --arm64 ${ARGS[@]+"${ARGS[@]}"}
    ;;
esac
