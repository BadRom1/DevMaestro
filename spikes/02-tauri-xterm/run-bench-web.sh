#!/usr/bin/env bash
# Mode web : le même front et les mêmes scénarios dans Google Chrome, au lieu de la webview
# WebKitGTK de Tauri. bench-web sert dist/ et une WebSocket sur 127.0.0.1, lance Chrome avec un
# profil jetable (out/chrome-profile, recréé à chaque passage), échantillonne bench-web + tout
# l'arbre de Chrome, puis ferme Chrome.
# Options communes (voir bench-lib.sh) : --batch-ms N, --rate N, --source synth|replay, --replay-file F,
#   --repeat N, --hidden-ipc on|off, --name SUFFIXE, --quick, --no-build, --monitor C.
# Option propre :
#   --dpr N          --force-device-scale-factor=N pour Chrome ; défaut : échelle GDK de la sortie visée
#                    (celle que voit WebKitGTK, lue par `tauri-xterm-bench --list-monitors`) ; 0 : ne pas forcer
# Variable : BENCH_CHROME (défaut /usr/bin/google-chrome).
# Codes de sortie : 0 RÉUSSI / ÉCHEC, 4 INCOMPLET, 3 partiel, 1 aucun rapport.
set -euo pipefail
cd "$(dirname "$0")"
source ./bench-lib.sh

dpr=
while (($#)); do
  n=0
  common_option "$@" || n=$?
  if ((n == 0)); then
    case "$1" in
      --dpr) dpr="${2:?--dpr attend un nombre (0 : ne pas forcer)}"; n=2 ;;
      *) echo "option inconnue : $1" >&2; exit 2 ;;
    esac
  fi
  shift "$n"
done
check_source

chrome="${BENCH_CHROME:-/usr/bin/google-chrome}"
[[ -x "$chrome" ]] || { echo "Chrome introuvable : $chrome (BENCH_CHROME)" >&2; exit 2; }
profile="$PWD/out/chrome-profile"
if pgrep -f -- "--user-data-dir=$profile" >/dev/null; then
  echo "Une instance Chrome utilise déjà $profile : la fermer d'abord." >&2
  exit 2
fi

bin=target/release/bench-web
if [[ $build == 1 ]]; then
  [[ -d node_modules ]] || npm ci
  npm run build
  cargo build --release -p bench-web
fi

# Densité de pixels : celle de WebKitGTK sur la même sortie (échelle GDK), sauf --dpr.
if [[ -z $dpr ]]; then
  tauri=target/release/tauri-xterm-bench
  if [[ -x $tauri ]]; then
    dpr=$("$tauri" --list-monitors 2>/dev/null | awk -v m="${BENCH_MONITOR:-}" '
      { for (i = 1; i <= NF; i++) if ($i == "GDK") s = $(i + 1); s = s + 0 }
      !first { first = s } $3 == m { found = s }
      END { print (found ? found : first) }')
  else
    echo "Attention : $tauri absent, densité de pixels de Chrome non alignée sur WebKitGTK (--dpr N)." >&2
  fi
fi
[[ $dpr == 0 ]] && dpr=
export BENCH_DPR="$dpr"

name=$(report_name "$bin")
export BENCH_REPORT_NAME="$name"
# Démarrage à froid à chaque passage, comme l'app Tauri.
rm -rf "$profile"
mkdir -p out "$profile"
export BENCH=1 BENCH_OUT="$PWD/out"
# Filet de sécurité : bench-web ferme Chrome lui-même, mais rien ne doit survivre au script.
trap 'pkill -f -- "--user-data-dir=$profile" 2>/dev/null || true' EXIT
setup_inhibit

# Profil jetable, fenêtre de la taille de la fenêtre Tauri ; tâches de fond coupées pour limiter le bruit ;
# pas de ralentissement des fenêtres masquées ni des minuteries (WebKit, lui, est gardé au premier plan).
# Plateforme (Wayland / XWayland) laissée au choix de Chrome sauf --monitor ; le rapport note ce qu'il a pris.
flags=(
  "--user-data-dir=$profile" --new-window --no-first-run --no-default-browser-check
  --window-size=1400,900 --password-store=basic
  --disable-background-networking --disable-component-update --disable-sync --hide-crash-restore-bubble
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling
)

echo "Banc d'essai web lancé dans Chrome (~5 min par répétition). Garder la fenêtre visible et au premier plan ; ne pas y toucher."
start=$(date +%s)
status=0
"${inhibit[@]}" "$bin" --bench --dist "$PWD/dist" -- "$chrome" "${flags[@]}" 2>&1 | tee "out/$name.log" || status=$?
echo "Durée : $(( $(date +%s) - start )) s, code de sortie : $status"
check_report "$name" "$status" "La fenêtre Chrome s'est-elle ouverte ? Voir out/$name.log."
