# Options et contrôles communs à run-bench.sh (Tauri) et run-bench-web.sh (Chrome), à sourcer.
# Options :
#   --batch-ms N     taille des lots en ms (10 par défaut)
#   --rate N         débit par session en Ko/s (20 par défaut ; ailleurs : -r<N> dans le nom du rapport)
#   --source S       synth (défaut, générateur) ou replay (rejeu en boucle d'une vraie capture PTY)
#   --replay-file F  capture rejouée (défaut : la session Claude Code réelle du prototype n° 1)
#   --repeat N       joue toute la matrice N fois (ordre des moteurs alterné), médiane + min/max
#   --hidden-ipc on|off  on (défaut, prudent) : les 10 sessions traversent le transport ;
#                    off (réaliste) : seules les sessions affichées, historique côté Rust
#   --name SUFFIXE   ajouté au nom du rapport
#   --quick          passages de 8 s, rapport out/report-quick-* (non concluant)
#   --no-build       réutilise le binaire déjà construit
#   --monitor C      plein écran sur la sortie C (connecteur, ex. eDP-1 ; liste : xrandr --listmonitors)
# Codes de sortie : 0 RÉUSSI ou ÉCHEC (complet et valide), 4 INCOMPLET ou cases invalides,
#   3 rapport partiel, 1 aucun rapport ; la dernière ligne donne le verdict et le chemin du rapport.
# Rapport : out/report[-quick]-<complet|realiste>-b<lots>[-r<débit>][-replay[-fichier]][-xN][-s<scénarios>]
#   [-<moteurs>][-<écran>][-nodmabuf][-chrome][-SUFFIXE]-AAAAMMJJ-HHMMSS.{md,json,log} ; jamais écrasé.
# Variables reconnues : BENCH_SCENARIOS=S0,S1,S2,S3,S4  BENCH_RENDERERS=dom,webgl
#                       BENCH_SCENARIO_S=25  BENCH_WARMUP_S=3  BENCH_TIMEOUT_S (calculé par défaut)

build=1
default_replay="$PWD/../01-pty-hooks/fixtures/pty-raw-session-reelle-2026-10-19.bin"

# Lit une option commune ; renvoie le nombre d'arguments consommés (0 : option inconnue).
common_option() {
  case "$1" in
    --batch-ms) export BENCH_BATCH_MS="${2:?--batch-ms attend un nombre}"; return 2 ;;
    --rate) export BENCH_RATE_KBPS="${2:?--rate attend un débit en Ko/s}"; return 2 ;;
    --source)
      case "${2:-}" in
        synth|replay) export BENCH_SOURCE="$2" ;;
        *) echo "--source attend synth ou replay" >&2; exit 2 ;;
      esac
      return 2 ;;
    --replay-file) export BENCH_REPLAY_FILE="${2:?--replay-file attend un fichier}"; return 2 ;;
    --hidden-ipc)
      case "${2:-}" in
        on) export BENCH_HIDDEN_IPC=1 ;;
        off) export BENCH_HIDDEN_IPC=0 ;;
        *) echo "--hidden-ipc attend on ou off" >&2; exit 2 ;;
      esac
      return 2 ;;
    --name) export BENCH_NAME="${2:?--name attend un suffixe}"; return 2 ;;
    --repeat) export BENCH_REPEAT="${2:?--repeat attend un nombre}"; return 2 ;;
    --quick) export BENCH_QUICK=1 BENCH_SCENARIO_S="${BENCH_SCENARIO_S:-8}"; return 1 ;;
    --no-build) build=0; return 1 ;;
    --monitor) export BENCH_MONITOR="${2:?--monitor attend un connecteur (ex. eDP-1)}"; return 2 ;;
  esac
  return 0
}

# Nom du rapport : calculé par le binaire lui-même (`--print-report-name`, règle de bench_core::config),
# avec un horodatage fixé ici pour que le passage écrive bien sous ce nom. $1 : binaire.
report_name() {
  export BENCH_STAMP="${BENCH_STAMP:-$(date +%Y%m%d-%H%M%S)}"
  "$1" --print-report-name
}

# Commande qui empêche la mise en veille et le verrouillage pendant le passage (tableau `inhibit`).
setup_inhibit() {
  local why="banc d'essai Orchestrateur"
  inhibit=()
  if command -v gnome-session-inhibit >/dev/null; then
    # Seule inhibition respectée par GNOME pour l'écran de verrouillage.
    inhibit=(gnome-session-inhibit --inhibit idle:suspend --reason "$why")
  elif command -v systemd-inhibit >/dev/null; then
    inhibit=(systemd-inhibit --what=idle:sleep --why="$why")
  fi
  ((${#inhibit[@]})) && export BENCH_INHIBIT="${inhibit[*]:0:3}" || unset BENCH_INHIBIT
}

# Prépare le rejeu : fichier par défaut, existence.
check_source() {
  if [[ "${BENCH_SOURCE:-synth}" == replay ]]; then
    export BENCH_REPLAY_FILE="${BENCH_REPLAY_FILE:-$default_replay}"
    [[ -s "$BENCH_REPLAY_FILE" ]] || { echo "capture introuvable ou vide : $BENCH_REPLAY_FILE" >&2; exit 2; }
  fi
}

# Contrôle du rapport après le passage ; $1 : nom, $2 : code de sortie, $3 : conseil si aucun rapport.
# Codes : 0 RÉUSSI ou ÉCHEC (complet, valide), 4 INCOMPLET / cases invalides, 3 partiel, 1 aucun rapport.
check_report() {
  local name=$1 status=$2 md="$PWD/out/$1.md" json="out/$1.json" verdict
  if [[ ! -f "$json" ]]; then
    echo "Aucun rapport écrit. $3" >&2
    echo "Verdict : AUCUN — rapport : absent ($md)"
    exit 1
  fi
  read -r verdict partial < <(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r["conclusion"]["verdict"], int(r["partial"]))' "$json")
  if [[ $status == 3 || $partial == 1 ]]; then
    echo "RAPPORT PARTIEL : le banc ne s'est pas terminé." >&2
    echo "Verdict : PARTIEL — rapport : $md"
    exit 3
  fi
  if [[ $verdict == INCOMPLET || $status != 0 ]]; then
    [[ $status != 0 ]] && echo "Le banc a quitté avec le code $status." >&2
    echo "Verdict : $verdict (cases manquantes ou invalides) — rapport : $md"
    exit 4
  fi
  echo "Verdict : $verdict — rapport : $md"
}
