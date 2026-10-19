#!/usr/bin/env bash
# Lance une session claude de test pour le prototype n° 1.
# Usage : run.sh [--profile perso|work] [--variant plugin|settings-hooks]
#                [--mode default|acceptEdits|plan|auto|dontAsk] [--timeout N] [--no-ptyhost] [-- "prompt initial"]
set -euo pipefail

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SPIKE_DIR/out"
profile=perso variant=plugin mode=default timeout="${SPIKE_HOOK_TIMEOUT:-600}" use_ptyhost=1 prompt=()

die() { echo "[spike] $*" >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "L'option $1 attend une valeur."; }

while (($#)); do
  case "$1" in
    --profile|--variant|--mode|--timeout) need_value "$@"; declare "${1#--}=$2"; shift 2 ;;
    --no-ptyhost) use_ptyhost=0; shift ;;
    --) shift; prompt=("$@"); break ;;
    *) die "Option inconnue : $1" ;;
  esac
done

case "$profile" in
  # Profil perso : on laisse CLAUDE_CONFIG_DIR vide, comme d'habitude. Le forcer à ~/.claude
  # ferait chercher ~/.claude/.claude.json au lieu de ~/.claude.json (état et confiance perdus).
  perso) unset CLAUDE_CONFIG_DIR ;;
  work) export CLAUDE_CONFIG_DIR="$HOME/.claude-work" ;;
  *) die "Profil inconnu : $profile (perso ou work)." ;;
esac
case "$variant" in plugin|settings-hooks) ;; *) die "Variante inconnue : $variant (plugin ou settings-hooks)." ;; esac
# claude 2.1.303 n'accepte pas « default » (choix : manual, acceptEdits, plan, auto, dontAsk…) ;
# « manual » est le mode par défaut, rapporté « default » dans les hooks.
case "$mode" in
  default|manual) cli_mode=manual ;;
  acceptEdits|plan|auto|dontAsk) cli_mode="$mode" ;;
  *) die "Mode inconnu : $mode (default, acceptEdits, plan, auto ou dontAsk)." ;;
esac
[[ "$timeout" =~ ^[0-9]+$ && "$timeout" -ge 2 ]] || die "Délai invalide : $timeout (entier, en secondes, ≥ 2)."

# Une seule session à la fois : FIFO, jeton et demandes en attente sont partagés dans out/.
mkdir -p "$OUT/pending" "$OUT/decisions"
if [[ -f "$OUT/run.pid" ]] && kill -0 "$(cat "$OUT/run.pid")" 2>/dev/null; then
  die "Une session tourne déjà (pid $(cat "$OUT/run.pid")). La fermer avant d'en lancer une autre (ou supprimer out/run.pid s'il est périmé)."
fi
echo $$ > "$OUT/run.pid"  # exec plus bas garde ce pid : il reste vivant tant que la session dure

rm -f "$OUT"/pending/* "$OUT"/decisions/*
session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
ORCH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
(umask 077; printf '%s\n' "$ORCH_TOKEN" > "$OUT/expected_token")
chmod 600 "$OUT/expected_token"
printf '%s\n' "$session_id" > "$OUT/session_id"
export ORCH_TOKEN SPIKE_DIR SPIKE_HOOK_TIMEOUT="$timeout"

python3 "$SPIKE_DIR/make_config.py" "$variant" "$timeout"
claude_version="$(claude --version 2>/dev/null || echo inconnue)"
RUN_INFO="$(printf '%s\t' "$variant" "$profile" "$mode" "$session_id" "$timeout" "$claude_version" "$use_ptyhost")" \
python3 - "$OUT/events.jsonl" <<'EOF'
import json, os, sys, time
variant, profile, mode, session_id, timeout, version, ptyhost = os.environ["RUN_INFO"].split("\t")[:7]
line = json.dumps({"ts": time.time(), "event": "run.start", "variant": variant, "profile": profile, "mode": mode,
                   "session_id": session_id, "timeout": int(timeout), "claude_version": version,
                   "ptyhost": ptyhost == "1"}, ensure_ascii=False) + "\n"
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
os.write(fd, line.encode())
os.close(fd)
EOF

# --settings et --plugin-dir prennent une seule valeur (pas « <…...> » dans claude --help) :
# le prompt placé en dernier ne peut pas être avalé comme valeur d'option.
cmd=(claude --session-id "$session_id" --permission-mode "$cli_mode" --settings "$OUT/settings.json")
[[ "$variant" == plugin ]] && cmd+=(--plugin-dir "$OUT/plugin")
cmd+=("${prompt[@]}")
[[ "$use_ptyhost" == 1 ]] && cmd=(python3 "$SPIKE_DIR/ptyhost.py" -- "${cmd[@]}")

echo "[spike] session_id : $session_id"
echo "[spike] profil     : $profile (CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<non défini>}) · $claude_version"
echo "[spike] variante   : $variant · mode : $mode · délai PermissionRequest : ${timeout} s · ptyhost : $use_ptyhost"
echo "[spike] journal    : $OUT/events.jsonl (python3 $SPIKE_DIR/show.py -f)"
sleep 1
exec "${cmd[@]}"
