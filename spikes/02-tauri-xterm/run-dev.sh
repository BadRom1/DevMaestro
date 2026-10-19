#!/usr/bin/env bash
# Mode manuel (tauri dev) : choix de la disposition, du moteur, pic, changement de session.
# Options : --pty (vrai bash dans le terminal 0), --no-dmabuf.
set -euo pipefail
cd "$(dirname "$0")"

app_args=()
for arg in "$@"; do
  case "$arg" in
    --pty) app_args+=(--pty) ;;
    --no-dmabuf) export WEBKIT_DISABLE_DMABUF_RENDERER=1 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

[[ -d node_modules ]] || npm ci
npx tauri dev -- -- "${app_args[@]}"
