# DevMaestro — front Electron (v0.1)

Interface de DevMaestro : une fenêtre Electron qui affiche et pilote les sessions Claude Code portées par le démon `orchd` ([ADR 0004](../docs/adr/0004-front-electron.md), [protocole](../docs/protocole.md)).

## Prérequis

- Node 24 et `pnpm` 10.
- Le démon construit à la racine du dépôt : `cargo build` (binaire `target/debug/orchd`).
- Pour les tests d'intégration du front : `cargo build -p devmaestro-core --features test-support` (faux `claude`).

## Commandes

```sh
pnpm install        # dépendances (le binaire Electron est téléchargé au premier lancement)
pnpm dev            # développement : Vite + rechargement à chaud de la page, relance du processus principal
pnpm build          # construit out/main, out/preload, out/renderer
pnpm start          # lance l'app construite (electron .)
pnpm typecheck      # TypeScript : processus principal, preload, page
pnpm test           # tests unitaires et d'intégration (vitest, sans fenêtre)
```

Au démarrage, l'app se connecte au socket de contrôle `$XDG_RUNTIME_DIR/devmaestro/orchd.sock` (repli : `$TMPDIR/devmaestro-<uid>/`, puis `/tmp/devmaestro-<uid>/`, comme le démon). Si le socket est absent, elle lance `orchd daemon`, détaché : il survit à la fermeture de l'app, et les sessions avec lui. Binaire utilisé :

- **app empaquetée** : uniquement `<ressources de l'app>/bin/orchd` (livré avec l'app). Ni le `PATH` ni `DEVMAESTRO_ORCHD_BIN` ne sont consultés : un autre binaire ne doit pas pouvoir se faire passer pour le démon ;
- **développement** (`pnpm dev`, `pnpm start`) : `DEVMAESTRO_ORCHD_BIN`, sinon `../target/debug/orchd` s'il existe, sinon `orchd` dans le `PATH`.

Le démon refuse les clients lancés depuis une session qu'il supervise (contrôle du pair, protocole § 1) : lancer l'app depuis un terminal ordinaire, pas depuis le terminal d'une session DevMaestro. L'app le signale (« Connexion refusée… ») au lieu de boucler.

Pour essayer sans toucher à ses vraies sessions, lancer l'app avec d'autres dossiers XDG (`XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) et, si besoin, `DEVMAESTRO_CLAUDE_BIN=../target/debug/devmaestro-fake-claude`.

## Architecture

| Partie | Rôle | Fichiers |
|---|---|---|
| Processus principal | Fenêtre, sécurité, client du démon (socket Unix, trames, JSON-RPC, reconnexion, lancement du démon), relais du terminal affiché | `src/main/` ; `src/main/daemon/` n'importe pas Electron (testé sous Node) |
| Preload | API minimale `window.devmaestro` par `contextBridge` ; transmet le `MessagePort` du terminal | `src/preload/index.ts` |
| Page | React : barre du haut, vue par projet, session (en-tête, cartes de permission et de question, terminal xterm.js) | `src/renderer/` |
| Contrat | Types du protocole et du pont page ↔ processus principal | `src/shared/` |

Octets du terminal : démon → trames `0x02` → processus principal, qui ne garde que la session affichée et les regroupe (au moins 1 Kio, ou au plus tard toutes les 16 ms) → `MessagePort`, en binaire (`Uint8Array`) → xterm.js. L'instantané d'écran passe par le même canal, juste avant les octets qui le suivent. Changer de session désabonne la précédente.

Contrôle de flux : la page accuse réception de chaque lot une fois écrit dans xterm. Au-delà de 2 Mio non acquittés, le processus principal suspend le flux et abandonne les octets ; quand la page est revenue sous 256 Kio, il redemande un instantané au démon (pas de rejeu).

Touches et collages : chemin inverse, en trames `0x03` d'au plus 64 Kio, en respectant la contre-pression du socket.

Les cartes de permission et de question flottent au bas du terminal sans changer sa taille. Une nouvelle carte prend le focus seulement si l'utilisateur n'est pas en train de taper (terminal ou champ de texte). Les liens OSC 8 du terminal s'ouvrent dans le navigateur après confirmation dans l'app (http et https seulement).

## Sécurité

`contextIsolation`, `sandbox`, pas de `nodeIntegration`, pas de `webview` ; navigation, redirections et nouvelles fenêtres bloquées (les liens http(s) s'ouvrent dans le navigateur) ; aucune permission web accordée ; seules les méthodes du démon utiles à la page sont relayées, après validation de leurs paramètres par le processus principal (UUID, entiers bornés, énumérations, longueurs maximales) ; seuls les messages du cadre principal de la fenêtre sont acceptés. Politique de contenu (balise `<meta>` de `src/renderer/index.html`, vérifiée à la construction contre `electron.vite.config.ts`) en production : rien hors de l'app, aucun script en ligne, aucune connexion (`connect-src 'none'`) ; les styles en ligne restent permis parce que xterm.js insère ses propres balises `<style>`. Polices (IBM Plex Sans, IBM Plex Sans Condensed, JetBrains Mono) embarquées : aucun accès réseau à l'exécution.

## Wayland

Electron 44 tourne en Wayland natif sous GNOME sans option (comportement par défaut depuis Electron 38.2). L'app écrit dans son journal la plateforme réellement utilisée par le processus GPU (`plateforme d'affichage : wayland (processus GPU)`). Pour forcer X11 : `pnpm start -- --ozone-platform=x11`.
