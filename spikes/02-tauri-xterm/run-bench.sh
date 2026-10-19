#!/usr/bin/env bash
# Construit l'app Tauri en release puis lance tous les scénarios sans intervention.
# Options communes (voir bench-lib.sh) : --batch-ms N, --rate N, --source synth|replay, --replay-file F,
#   --repeat N, --hidden-ipc on|off, --name SUFFIXE, --quick, --no-build, --monitor C.
# Option propre :
#   --no-dmabuf      WEBKIT_DISABLE_DMABUF_RENDERER=1 (fenêtre blanche sur certains GPU / Wayland)
# Codes de sortie : 0 RÉUSSI / ÉCHEC, 4 INCOMPLET, 3 partiel, 1 aucun rapport.
set -euo pipefail
cd "$(dirname "$0")"
source ./bench-lib.sh

while (($#)); do
  n=0
  common_option "$@" || n=$?
  if ((n == 0)); then
    case "$1" in
      --no-dmabuf) export WEBKIT_DISABLE_DMABUF_RENDERER=1 ;;
      *) echo "option inconnue : $1" >&2; exit 2 ;;
    esac
    n=1
  fi
  shift "$n"
done
check_source

bin=target/release/tauri-xterm-bench
if [[ $build == 1 ]]; then
  [[ -d node_modules ]] || npm ci
  npx tauri build --no-bundle
elif [[ ! -x $bin ]]; then
  echo "$bin absent : relancer sans --no-build." >&2
  exit 2
elif [[ -n "$(find dist -newer "$bin" -print -quit 2>/dev/null)" ]]; then
  # Le front est embarqué à la compilation : un dist/ plus récent ne serait pas celui mesuré.
  echo "dist/ est plus récent que $bin (front embarqué périmé) : relancer sans --no-build." >&2
  exit 2
fi

name=$(report_name "$bin")
export BENCH_REPORT_NAME="$name"
mkdir -p out
export BENCH=1 BENCH_OUT="$PWD/out"
setup_inhibit

echo "Banc d'essai lancé (~5 min par répétition). Garder la fenêtre visible et au premier plan ; ne pas y toucher."
start=$(date +%s)
status=0
"${inhibit[@]}" "$bin" --bench 2>&1 | tee "out/$name.log" || status=$?
echo "Durée : $(( $(date +%s) - start )) s, code de sortie : $status"
check_report "$name" "$status" "Si la fenêtre est restée blanche, relancer avec --no-dmabuf."
