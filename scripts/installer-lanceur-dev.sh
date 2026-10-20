#!/usr/bin/env bash
# Installe de quoi lancer DevMaestro (version de développement) depuis le menu GNOME,
# sans passer par une session Claude Code :
#   1. un profil AppArmor qui autorise le bac à sable de Chromium (espaces de noms)
#      pour LE binaire Electron de ce dépôt, chemin exact (Ubuntu 24.04+ :
#      kernel.apparmor_restrict_unprivileged_userns = 1) ;
#   2. une entrée « DevMaestro (dev) » dans le menu des applications.
#
# Le profil est du même type que ceux fournis par Ubuntu pour VS Code ou Obsidian :
# il ne restreint rien, il donne seulement le droit « userns ». Différence à connaître :
# ici le binaire est dans node_modules, donc modifiable par l'utilisateur (une dépendance
# malveillante installée par pnpm pourrait le remplacer et profiter de ce droit). Le profil
# vise le chemin exact de la version installée ; à relancer après une mise à jour d'Electron.
#
# Désinstallation : installer-lanceur-dev.sh --desinstaller
set -euo pipefail

depot="$(cd "$(dirname "$0")/.." && pwd -P)"
# Liste blanche : le chemin entre tel quel dans un profil AppArmor et dans un .desktop.
if [[ ! "$depot" =~ ^[A-Za-z0-9_./-]+$ ]]; then
  echo "Chemin du dépôt non pris en charge (caractères autorisés : lettres, chiffres, _ . / -) : $depot" >&2
  exit 1
fi

profil=/etc/apparmor.d/devmaestro-dev
lanceur="${XDG_DATA_HOME:-$HOME/.local/share}/applications/devmaestro-dev.desktop"

if ! command -v apparmor_parser >/dev/null 2>&1; then
  echo "apparmor_parser introuvable : AppArmor n'est pas installé, ce script est inutile." >&2
  exit 1
fi

if [[ "${1:-}" == "--desinstaller" ]]; then
  rm -f "$lanceur"
  if [[ -f "$profil" ]]; then
    sudo apparmor_parser -R "$profil" || echo "Profil déjà déchargé ou introuvable dans le noyau."
    sudo rm -f "$profil"
  fi
  echo "Lanceur et profil AppArmor retirés."
  exit 0
fi

electron=""
for candidat in "$depot"/app/node_modules/.pnpm/electron@*/node_modules/electron/dist/electron; do
  [[ -x "$candidat" ]] && electron="$(realpath "$candidat")"
done
if [[ -z "$electron" ]]; then
  echo "Binaire Electron introuvable : lancer « pnpm install » dans app/ d'abord." >&2
  exit 1
fi
if [[ ! "$electron" =~ ^[A-Za-z0-9_./@-]+$ ]]; then
  echo "Chemin d'Electron non pris en charge : $electron" >&2
  exit 1
fi
if [[ ! -f "$depot/app/out/main/index.js" ]]; then
  echo "App non construite : lancer « pnpm build » dans app/ d'abord." >&2
  exit 1
fi
orchd="$depot/target/debug/orchd"
if [[ ! -x "$orchd" ]]; then
  echo "Démon introuvable ($orchd) : lancer « cargo build » à la racine du dépôt d'abord." >&2
  exit 1
fi
claude_bin="$(command -v claude || true)"
if [[ -z "$claude_bin" ]]; then
  echo "claude introuvable dans le PATH de ce shell : le démon ne pourra pas lancer de session." >&2
  exit 1
fi
if [[ ! -f /etc/apparmor.d/abi/5.0 ]]; then
  echo "ABI AppArmor 5.0 absente de /etc/apparmor.d/abi : version d'AppArmor non prise en charge." >&2
  exit 1
fi

# PATH minimal et explicite pour le lanceur : une app lancée depuis GNOME ne lit ni
# fish ni mise. On y met le dossier de claude et les dossiers système.
chemin_lanceur="$(dirname "$claude_bin"):/usr/local/bin:/usr/bin:/bin"
if [[ ! "$chemin_lanceur" =~ ^[A-Za-z0-9_./:-]+$ ]]; then
  echo "PATH du lanceur non pris en charge : $chemin_lanceur" >&2
  exit 1
fi

contenu_profil="# DevMaestro (développement) : autorise le bac à sable de Chromium
# pour le binaire Electron de $depot (chemin exact).
# Ne restreint rien d'autre (même principe que /etc/apparmor.d/code).

abi <abi/5.0>,
include <tunables/global>

profile devmaestro-dev $electron flags=(unconfined) {
  userns,

  include if exists <local/devmaestro-dev>
}
"

if [[ -f "$profil" ]] && ! grep -qF "$electron" "$profil"; then
  echo "Attention : $profil existe déjà pour un autre binaire (autre clone ou ancienne version d'Electron) : il sera remplacé."
fi
echo "Profil AppArmor qui va être écrit dans $profil :"
echo "------------------------------------------------------------"
echo "$contenu_profil"
echo "------------------------------------------------------------"
read -r -p "Installer ce profil (sudo demandé) ? [o/N] " reponse
if [[ "$reponse" != "o" && "$reponse" != "O" ]]; then
  echo "Abandon : rien n'a été modifié."
  exit 1
fi
if ! printf '%s' "$contenu_profil" | sudo tee "$profil" >/dev/null; then
  echo "Écriture du profil impossible (sudo refusé ?) : rien n'a été modifié." >&2
  exit 1
fi
if ! sudo apparmor_parser -r "$profil"; then
  echo "Chargement du profil refusé : fichier retiré." >&2
  sudo rm -f "$profil"
  exit 1
fi
echo "Profil chargé."

mkdir -p "$(dirname "$lanceur")"
cat >"$lanceur" <<EOF
[Desktop Entry]
Type=Application
Name=DevMaestro (dev)
Comment=Suivre et piloter les sessions Claude Code
Exec=env PATH=$chemin_lanceur DEVMAESTRO_ORCHD_BIN=$orchd $electron $depot/app
Path=$depot/app
Terminal=false
StartupNotify=true
Categories=Development;
EOF
chmod 0644 "$lanceur"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$lanceur")" || true
echo "Lanceur installé : $lanceur"
echo "Après une mise à jour d'Electron ou un déplacement du dépôt, relancer ce script."
