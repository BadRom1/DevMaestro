#!/usr/bin/env bash
# Construit le paquet Debian de DevMaestro : dist/devmaestro_<version>_amd64.deb.
#
#   1. `orchd` en release (cargo, --locked) ;
#   2. le front (pnpm, lockfile figé) ;
#   3. une arborescence assemblée à la main à partir d'Electron déjà présent dans
#      app/node_modules (aucun outil d'empaquetage de plus) ;
#   4. `dpkg-deb --build`, puis quelques contrôles du résultat.
#
# Contrat, contenu installé et choix du bac à sable : docs/v0.3.md, « Paquet .deb ».
# N'installe rien, ne touche ni /etc ni le démon en service : produit un fichier.
#
# Installation par l'utilisateur : sudo apt install ./dist/devmaestro_<version>_amd64.deb
set -euo pipefail

depot="$(cd "$(dirname "$0")/.." && pwd -P)"
app="$depot/app"
dist="$depot/dist"

paquet=devmaestro
prefixe=/opt/devmaestro
mainteneur="Romain <romain.badino@hotmail.fr>"
site="https://github.com/BadRom1/DevMaestro"

echec() {
  echo "paquet-deb : $*" >&2
  exit 1
}

for outil in cargo pnpm node dpkg-deb dpkg-shlibdeps strip gzip git; do
  command -v "$outil" >/dev/null 2>&1 || echec "outil introuvable : $outil"
done

arch="$(dpkg --print-architecture)"
[[ "$arch" == amd64 ]] || echec "architecture $arch non prise en charge (Electron de node_modules : x64)"

# --- Version : app/package.json, égale à celle du workspace Cargo ----------------------
version="$(node -p 'require(process.argv[1]).version' "$app/package.json")"
version_cargo="$(cargo metadata --no-deps --format-version 1 --manifest-path "$depot/Cargo.toml" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).packages.find(p=>p.name==="devmaestro-core");console.log(p?p.version:"")})')"
[[ -n "$version" && "$version" == "$version_cargo" ]] ||
  echec "versions différentes : app/package.json « $version », Cargo « $version_cargo »"
[[ "$version" =~ ^[0-9][0-9A-Za-z.+~-]*$ ]] || echec "version non valable pour Debian : $version"

# Dépôt propre exigé : le paquet correspond à un commit. DEVMAESTRO_ALLOW_DIRTY=1
# l'autorise pour un essai, la version porte alors « +dirty ».
commit="$(git -C "$depot" rev-parse --short HEAD)"
if [[ -n "$(git -C "$depot" status --porcelain)" ]]; then
  [[ "${DEVMAESTRO_ALLOW_DIRTY:-}" == 1 ]] ||
    echec "modifications non commitées : commiter d'abord, ou DEVMAESTRO_ALLOW_DIRTY=1 pour un paquet d'essai (version « +dirty »)"
  echo "Attention : modifications non commitées incluses, version marquée « +dirty »."
  version="$version+dirty"
  commit="$commit+dirty"
fi

# Dates fixées à celle du dernier commit (sauf SOURCE_DATE_EPOCH fourni) et chemins de
# construction retirés du binaire : même contenu pour un même commit, sur une même
# machine avec les mêmes outils.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$depot" log -1 --format=%ct)}"

# --- 1. Démon --------------------------------------------------------------------------
echo "==> orchd (release)"
# Dossier cible à part : les RUSTFLAGS du paquet ne cassent pas le cache de target/release.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
RUSTFLAGS="--remap-path-prefix=$depot=/build/devmaestro --remap-path-prefix=$cargo_home=/cargo" \
  cargo build --release --locked --manifest-path "$depot/Cargo.toml" --target-dir "$depot/target/paquet" \
  -p devmaestro-core --bin orchd
orchd="$depot/target/paquet/release/orchd"
[[ -x "$orchd" ]] || echec "binaire absent après construction : $orchd"

# --- 2. Front --------------------------------------------------------------------------
echo "==> front (pnpm)"
pnpm --dir "$app" install --frozen-lockfile
pnpm --dir "$app" build
[[ -f "$app/out/main/index.js" ]] || echec "construction du front incomplète (out/main/index.js absent)"

electron_dist="$app/node_modules/electron/dist"
[[ -x "$electron_dist/electron" ]] || echec "Electron absent de node_modules (pnpm install a-t-il téléchargé le binaire ?)"
electron_attendu="$(node -p 'require(process.argv[1]).devDependencies.electron' "$app/package.json")"
electron_present="$(<"$electron_dist/version")"
[[ "$electron_present" == "$electron_attendu" ]] ||
  echec "Electron $electron_present dans node_modules, $electron_attendu attendu par app/package.json"

# --- 3. Arborescence -------------------------------------------------------------------
echo "==> arborescence"
mkdir -p "$dist"
travail="$(mktemp -d "$dist/.construction.XXXXXX")"
trap 'rm -rf "$travail"' EXIT
racine="$travail/racine"
opt="$racine$prefixe"
mkdir -p "$opt" "$racine/DEBIAN"

# Electron, renommé : `app.isPackaged` est vrai dès que l'exécutable ne s'appelle plus
# `electron`, et `process.resourcesPath` vaut alors $prefixe/resources.
cp -R "$electron_dist/." "$opt/"
rm -f "$opt/version" "$opt/resources/default_app.asar"
mv "$opt/electron" "$opt/devmaestro"

# L'app : `out/` et un package.json minimal (aucune dépendance d'exécution : tout est
# empaqueté par electron-vite).
mkdir -p "$opt/resources/app"
cp -R "$app/out" "$opt/resources/app/out"
node -e '
  const src = require(process.argv[1])
  const min = {
    name: src.name,
    productName: src.productName,
    version: src.version,
    description: src.description,
    license: src.license,
    main: src.main,
    desktopName: "devmaestro.desktop",
  }
  require("node:fs").writeFileSync(process.argv[2], JSON.stringify(min, null, 2) + "\n")
' "$app/package.json" "$opt/resources/app/package.json"

# Le démon, seul chemin accepté par l'app empaquetée (app/src/main/daemon/spawn.ts).
install -D -m 0755 "$orchd" "$opt/resources/bin/orchd"
strip --strip-unneeded "$opt/resources/bin/orchd"

mkdir -p "$racine/usr/bin"
ln -s "$prefixe/devmaestro" "$racine/usr/bin/devmaestro"

install -D -m 0644 "$app/resources/icon.svg" "$racine/usr/share/icons/hicolor/scalable/apps/devmaestro.svg"

install -d "$racine/usr/share/applications"
cat >"$racine/usr/share/applications/devmaestro.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=DevMaestro
GenericName=Suivi des sessions Claude Code
GenericName[en]=Claude Code session tracker
Comment=Suivre et piloter plusieurs sessions Claude Code
Comment[en]=Track and drive several Claude Code sessions
Exec=/usr/bin/devmaestro
Icon=devmaestro
Terminal=false
StartupNotify=true
StartupWMClass=DevMaestro
Categories=Development;
Keywords=Claude;IA;AI;agent;terminal;git;
EOF

# Profil AppArmor : autorise les espaces de noms (bac à sable de Chromium) au seul
# binaire installé, sans rien restreindre (même forme que /etc/apparmor.d/code).
# ABI 4.0 : présente depuis Ubuntu 24.04.
install -d "$racine/etc/apparmor.d"
cat >"$racine/etc/apparmor.d/devmaestro" <<EOF
# DevMaestro : autorise le bac à sable de Chromium (espaces de noms non privilégiés,
# Ubuntu 24.04+ : kernel.apparmor_restrict_unprivileged_userns = 1) pour le binaire
# installé par le paquet. Ne restreint rien d'autre.

abi <abi/4.0>,
include <tunables/global>

profile devmaestro $prefixe/devmaestro flags=(unconfined) {
  userns,

  # Compléments locaux : /etc/apparmor.d/local/devmaestro
  include if exists <local/devmaestro>
}
EOF

# Documentation : licences (Electron et Chromium redistribués), journal des versions.
doc="$racine/usr/share/doc/$paquet"
install -d "$doc"
mv "$opt/LICENSE" "$doc/LICENSE.electron"
mv "$opt/LICENSES.chromium.html" "$doc/LICENSES.chromium.html"
cat >"$doc/README.Debian" <<'FIN'
DevMaestro pour Debian et Ubuntu
================================

Lancement : menu des applications (« DevMaestro ») ou commande devmaestro.
L'app lance son démon (/opt/devmaestro/resources/bin/orchd) s'il n'est pas
déjà en service ; il continue après la fermeture de la fenêtre, avec les
sessions.

claude doit être dans le PATH de la session graphique (~/.local/bin l'est
sous Ubuntu s'il existe à l'ouverture de session). Sinon, indiquer son
chemin dans DEVMAESTRO_CLAUDE_BIN, par exemple dans
~/.config/environment.d/devmaestro.conf :
  DEVMAESTRO_CLAUDE_BIN=/chemin/vers/claude

Un seul démon à la fois
-----------------------
Le démon installé et celui d'un dépôt de développement partagent le même
socket ($XDG_RUNTIME_DIR/devmaestro/orchd.sock) et le même plugin Claude Code
généré (~/.local/share/devmaestro/claude-plugin) : n'en faire tourner qu'un.
L'app se connecte au démon déjà en service, quel qu'il soit ; si son
protocole diffère, elle affiche « Démon incompatible : … ».

Après une mise à jour, l'ancien démon reste en service jusqu'à son arrêt :
terminer les sessions, quitter l'app, arrêter orchd (pkill -x orchd), puis
relancer l'app.

Après « apt remove », un démon encore lancé et les hooks de son plugin
pointent vers un binaire absent jusqu'à l'arrêt du démon : terminer les
sessions et arrêter orchd.

Dépannage : « No usable sandbox »
---------------------------------
Ubuntu 24.04 et suivantes limitent les espaces de noms non privilégiés
(kernel.apparmor_restrict_unprivileged_userns = 1), dont le bac à sable de
Chromium a besoin. Le paquet installe pour cela le profil AppArmor
/etc/apparmor.d/devmaestro et le charge à l'installation. Si l'app s'arrête
au démarrage avec « No usable sandbox » ou « The SUID sandbox helper binary
was found, but is not configured correctly » :

  sudo apparmor_parser -r /etc/apparmor.d/devmaestro

puis relancer l'app (contrôle : sudo aa-status | grep devmaestro).
Ne pas lancer l'app avec --no-sandbox.
FIN
licence="$(node -p 'require(process.argv[1]).license' "$app/package.json")"
cat >"$doc/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: DevMaestro
Upstream-Contact: $mainteneur
Source: $site

Files: *
Copyright: 2026 Romain
License: $licence
 Licence provisoire, reprise de app/package.json : le choix définitif reste
 ouvert (voir docs/feuille-de-route.md du dépôt).

Files: opt/devmaestro/*
Copyright: Electron contributors, The Chromium Authors et autres
License: MIT et licences de Chromium
 Voir /usr/share/doc/$paquet/LICENSE.electron et
 /usr/share/doc/$paquet/LICENSES.chromium.html.
EOF
date_commit="$(LC_ALL=C date -u -d "@$SOURCE_DATE_EPOCH" '+%a, %d %b %Y %H:%M:%S +0000')"
printf '%s (%s) unstable; urgency=low\n\n  * Version %s, construite depuis le commit %s.\n\n -- %s  %s\n' \
  "$paquet" "$version" "$version" "$commit" "$mainteneur" "$date_commit" |
  gzip -9n >"$doc/changelog.gz"

# Droits : dossiers 0755, fichiers 0644, puis exécutables 0755. chrome-sandbox sans
# setuid : le bac à sable passe par le profil AppArmor (docs/v0.3.md).
find "$racine" -type d -exec chmod 0755 {} +
find "$racine" -type f -exec chmod 0644 {} +
chmod 0755 "$opt/devmaestro" "$opt/chrome-sandbox" "$opt/chrome_crashpad_handler" "$opt/resources/bin/orchd"

# --- Métadonnées -----------------------------------------------------------------------
# Dépendances : calculées par dpkg-shlibdeps sur tous les objets ELF installés ; les
# bibliothèques livrées avec Electron (libffmpeg.so…) sont trouvées par -l.
elfs=()
while IFS= read -r -d '' f; do
  if [[ "$(od -An -tx1 -N4 "$f" | tr -d ' \n')" == 7f454c46 ]]; then
    elfs+=("-e${f#"$travail/"}")
  fi
done < <(find "$opt" -type f -print0 | sort -z)
mkdir -p "$travail/debian"
printf 'Source: %s\n\nPackage: %s\nArchitecture: %s\n' "$paquet" "$paquet" "$arch" >"$travail/debian/control"
# Avertissements affichés. Attendus : « impossible d'extraire le nom et la version » pour
# libffmpeg.so (livrée par Electron, sans paquet) et « détournements en jeu » si la machine
# de construction a des détournements dpkg (dpkg-divert) sans rapport avec ces bibliothèques.
shlibs="$(cd "$travail" && dpkg-shlibdeps -O --ignore-missing-info -l"racine$prefixe" "${elfs[@]}")" ||
  echec "dpkg-shlibdeps a échoué"
depends="${shlibs#shlibs:Depends=}"
[[ -n "$depends" && "$depends" != "$shlibs" ]] || echec "dpkg-shlibdeps n'a rien calculé"
rm -rf "$travail/debian"
# Chargés à l'exécution, invisibles pour dpkg-shlibdeps (vu dans le binaire Electron) :
# libnotify.so.4 par dlopen (notifications natives), xdg-open (shell.openExternal).
depends="$depends, libnotify4, xdg-utils"

taille="$(du -sk --apparent-size "$racine" --exclude=DEBIAN | cut -f1)"

cat >"$racine/DEBIAN/control" <<EOF
Package: $paquet
Version: $version
Architecture: $arch
Maintainer: $mainteneur
Installed-Size: $taille
Depends: $depends
Recommends: git, gh
Section: devel
Priority: optional
Homepage: $site
Description: suivre et piloter plusieurs sessions Claude Code
 DevMaestro affiche et pilote plusieurs sessions Claude Code depuis une seule
 fenêtre : état de chaque session, demandes de permission, terminal,
 conversation, diff, commits, worktrees et forge (via gh).
 .
 Un démon local (orchd) porte les sessions dans des pseudo-terminaux ; l'app
 Electron s'y connecte par un socket Unix réservé à l'utilisateur. Aucun port
 réseau, aucune télémétrie, aucune modification de la configuration de
 Claude Code.
EOF

echo "/etc/apparmor.d/devmaestro" >"$racine/DEBIAN/conffiles"

cat >"$racine/DEBIAN/postinst" <<'EOF'
#!/bin/sh
# devmaestro : charge le profil AppArmor du bac à sable de Chromium.
# Sans réseau, idempotent ; un échec du chargement n'empêche pas l'installation.
set -e

profil=/etc/apparmor.d/devmaestro

apparmor_actif() {
    command -v apparmor_parser >/dev/null 2>&1 || return 1
    if command -v aa-enabled >/dev/null 2>&1; then
        aa-enabled --quiet 2>/dev/null
    else
        [ -d /sys/kernel/security/apparmor ]
    fi
}

case "$1" in
    configure)
        if [ -f "$profil" ] && apparmor_actif; then
            if ! apparmor_parser -r -T -W "$profil"; then
                echo "devmaestro : chargement du profil AppArmor $profil impossible." >&2
                echo "  Sans lui, DevMaestro peut s'arrêter au démarrage (« No usable sandbox »)." >&2
                echo "  Rattrapage : sudo apparmor_parser -r $profil" >&2
                echo "  Voir /usr/share/doc/devmaestro/README.Debian, « Dépannage »." >&2
            fi
        fi
        # Mise à jour : un démon déjà lancé garde l'ancien binaire jusqu'à son arrêt.
        if [ -n "$2" ]; then
            echo "devmaestro : mis à jour depuis la version $2. Un démon orchd déjà lancé" >&2
            echo "  reste l'ancien jusqu'à son arrêt : terminer les sessions, quitter DevMaestro," >&2
            echo "  arrêter orchd (pkill -x orchd), puis relancer DevMaestro." >&2
        fi
        ;;
    abort-upgrade|abort-remove|abort-deconfigure)
        ;;
    *)
        echo "postinst appelé avec un argument inconnu : « $1 »" >&2
        exit 1
        ;;
esac

exit 0
EOF

cat >"$racine/DEBIAN/postrm" <<'EOF'
#!/bin/sh
# devmaestro : décharge le profil AppArmor au retrait du paquet.
# Le profil est un fichier de configuration : présent pendant « remove »,
# retiré par dpkg au « purge ».
set -e

profil=/etc/apparmor.d/devmaestro

apparmor_actif() {
    command -v apparmor_parser >/dev/null 2>&1 || return 1
    if command -v aa-enabled >/dev/null 2>&1; then
        aa-enabled --quiet 2>/dev/null
    else
        [ -d /sys/kernel/security/apparmor ]
    fi
}

case "$1" in
    remove)
        if [ -f "$profil" ] && apparmor_actif; then
            apparmor_parser -R "$profil" >/dev/null 2>&1 || true
        fi
        ;;
    purge)
        rm -f /var/cache/apparmor/*/devmaestro
        ;;
    upgrade|failed-upgrade|abort-install|abort-upgrade|disappear)
        ;;
    *)
        echo "postrm appelé avec un argument inconnu : « $1 »" >&2
        exit 1
        ;;
esac

exit 0
EOF
chmod 0755 "$racine/DEBIAN/postinst" "$racine/DEBIAN/postrm"
chmod 0644 "$racine/DEBIAN/control" "$racine/DEBIAN/conffiles"

# Dates : celle du commit, pour un contenu reproductible.
find "$racine" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# --- 4. Paquet et contrôles ------------------------------------------------------------
deb="$dist/${paquet}_${version}_${arch}.deb"
rm -f "$deb"
dpkg-deb --root-owner-group -Zxz --build "$racine" "$deb" >/dev/null

contenu="$(dpkg-deb --contents "$deb")"
for attendu in \
  ".$prefixe/devmaestro" \
  ".$prefixe/resources/bin/orchd" \
  ".$prefixe/resources/app/package.json" \
  ".$prefixe/resources/app/out/main/index.js" \
  "./usr/bin/devmaestro -> $prefixe/devmaestro" \
  "./usr/share/applications/devmaestro.desktop" \
  "./etc/apparmor.d/devmaestro"; do
  grep -qF " $attendu" <<<"$contenu" || echec "absent du paquet : $attendu"
done
if grep -E '^[-d]..[sS]|^[-d].....[sS]' <<<"$contenu"; then
  echec "fichier setuid ou setgid dans le paquet"
fi
if grep -qF 'default_app.asar' <<<"$contenu"; then
  echec "default_app.asar ne doit pas être livré"
fi
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$racine/usr/share/applications/devmaestro.desktop"
fi

# Contrôle de fumée sur l'arbre extrait du paquet : `orchd` tel que l'app empaquetée le
# résout (même fonction, app/src/main/daemon/spawn.ts), avec `process.resourcesPath`
# calculé comme Electron (dossier de l'exécutable + /resources).
extrait="$travail/extrait"
dpkg-deb -x "$deb" "$extrait"
exe="$extrait$prefixe/devmaestro"
[[ -x "$exe" ]] || echec "exécutable de l'app absent de l'arbre extrait"
orchd_resolu="$(node --no-warnings -e '
  const path = require("node:path")
  const exe = process.argv[2]
  import(process.argv[1]).then((m) => {
    const resourcesPath = path.join(path.dirname(exe), "resources")
    console.log(m.resolveOrchdBin({ env: {}, appPath: path.join(resourcesPath, "app"), packaged: true, resourcesPath }))
  })
' "$app/src/main/daemon/spawn.ts" "$exe")"
[[ -f "$orchd_resolu" && -x "$orchd_resolu" ]] || echec "orchd résolu par l'app introuvable ou non exécutable : $orchd_resolu"
"$orchd_resolu" --version | grep -qF "$(node -p 'require(process.argv[1]).version' "$app/package.json")" ||
  echec "orchd résolu ($orchd_resolu) : version inattendue"
echo "orchd résolu depuis le paquet : ${orchd_resolu#"$extrait"}"

echo "==> $deb"
dpkg-deb --field "$deb" Package Version Architecture Installed-Size
echo "Installation : sudo apt install $deb"
