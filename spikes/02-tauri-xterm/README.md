# Prototype n° 2 : banc d'essai Tauri 2 + xterm.js

Outillage jetable. Il répond à une question : Tauri 2 (webview WebKitGTK) et xterm.js tiennent-ils une dizaine de sessions qui défilent en même temps ? Spécification et critères : [`docs/spikes/02-tauri-xterm.md`](../../docs/spikes/02-tauri-xterm.md).

## Prérequis

- Paquets Linux de Tauri 2 : `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` (vérifier avec `pkg-config --modversion webkit2gtk-4.1`).
- Rust (cargo) et Node 24 avec npm.

## Lancer le banc d'essai

```sh
./run-bench.sh                 # construit en release, puis joue tous les scénarios
./run-bench.sh --no-dmabuf     # si la fenêtre reste blanche (voir plus bas)
./run-bench.sh --repeat 3      # toute la matrice 3 fois, ordre des moteurs alterné, médiane + min/max
./run-bench.sh --batch-ms 50   # lots IPC de 50 ms au lieu de 10 (pour comparer deux rapports)
./run-bench.sh --hidden-ipc off  # mode réaliste : seules les sessions affichées traversent l'IPC
./run-bench.sh --name essai2   # suffixe ajouté au nom du rapport
./run-bench.sh --quick         # passages de 8 s, rapport out/report-quick-* (non concluant)
./run-bench.sh --no-build      # réutilise le binaire déjà construit
./run-bench.sh --rate 2        # débit par session en Ko/s (20 par défaut ; une vraie session : ~0,8 en moyenne)
./run-bench.sh --source replay # rejoue en boucle la vraie capture PTY du prototype n° 1 au lieu du générateur
./run-bench.sh --monitor eDP-1 # plein écran sur cette sortie, sans rien toucher (aussi pour run-bench-web.sh)
```

- **Durée** : environ 5 min par répétition (3 s de référence au repos, puis 9 passages de 3 s d'échauffement + 25 s de mesure + jusqu'à 2 s de grâce), plus la compilation la première fois.
- **Pendant la mesure, la fenêtre doit rester visible et au premier plan** : WebKit ralentit les fenêtres cachées ou recouvertes. L'app demande à être « toujours au-dessus », mais GNOME sous Wayland ignore cette demande : c'est à vous de la laisser devant. Ne pas la réduire, ne pas changer d'espace de travail, ne pas taper dedans. La ligne d'état en haut indique où en est le banc (« S2 · WebGL · passage 1/1 · 12 s / 28 s »). Une fenêtre cachée pendant une mesure invalide le passage ; une fenêtre partiellement recouverte n'est pas détectée.
- L'app se ferme seule à la fin. Si le front reste bloqué, un garde-fou écrit un **rapport partiel** (délai calculé d'après la configuration, ou `BENCH_TIMEOUT_S`) et quitte avec le code 3 ; le script affiche alors « RAPPORT PARTIEL » et sort en erreur.
- Une valeur invalide (`BENCH_SCENARIO_S=abc`, scénario ou moteur inconnu) arrête l'app au démarrage.

Le transport, la validité et l'encodage décrits ci-dessous en termes d'IPC Tauri valent aussi pour le mode web (WebSocket), voir « Mode web ».

Toujours construire avec `tauri build` (c'est ce que fait le script) : un simple `cargo build --release` produit un binaire de développement qui cherche le front sur `localhost:5173`.

Le nom du rapport porte aussi le débit s'il diffère de 20 Ko/s (`-r2`) et `-replay` pour le rejeu ; l'en-tête les rappelle. Le rejeu (`--replay-file F` pour une autre capture) démarre chaque session à un endroit différent de la capture, coupe les lots avant un `ESC` ou après un saut de ligne, et retire les bascules d'écran alternatif ; en S2 / S3, pic et historique sont alors des redessins de TUI, pas un `cat`. Sous ~1 Ko/s, le générateur synthétique dépasse `--rate` (le spinner seul fait ~1,05 Ko/s) : l'en-tête donne le débit réellement produit.

Les terminaux sont dans une boîte fixe de 1200×760 px CSS (S4 : la même boîte en 2 × 5) : mêmes colonnes×lignes dans les deux moteurs, quelle que soit la fenêtre ; l'en-tête donne colonnes×lignes, devicePixelRatio, la fenêtre, l'écran vu par la page et le mode de la sortie (Mutter). Avec `--monitor`, Tauri demande `gtk_window_fullscreen_on_monitor` sur la sortie (trouvée par son connecteur GDK, sinon par sa position logique selon Mutter) et vérifie 3 s plus tard où est la fenêtre ; `target/release/tauri-xterm-bench --list-monitors` liste les sorties vues par GTK. Si la sortie n'est pas atteinte, le banc tourne quand même et l'en-tête le dit (« écran : résultat »).

## Mode web (Chrome) : la part de WebKitGTK

```sh
./run-bench-web.sh --hidden-ipc off --batch-ms 16   # mêmes options que run-bench.sh (sauf --no-dmabuf)
```

Même front, mêmes scénarios, mêmes générateurs, mêmes lots, mêmes mesures et mêmes règles de validité ; seuls changent le moteur (Chromium au lieu de WebKitGTK) et le transport (WebSocket au lieu de l'IPC Tauri). Le rapport porte la marque `-chrome` (`out/report-realiste-b16-chrome.md`).

- `bench-web` (crate `web/`) sert `dist/` en HTTP sur 127.0.0.1 et une WebSocket sur le même port : trames binaires (un octet de session puis les octets), trames texte JSON pour les commandes (mêmes noms que les commandes Tauri). Le front choisit le transport au démarrage (`?transport=ws`, ou absence de Tauri).
- `bench-web` lance lui-même Chrome (`BENCH_CHROME`, défaut `/usr/bin/google-chrome`) avec un profil jetable `out/chrome-profile`, une fenêtre `--app` de 1400×900 et les tâches de fond coupées ; il échantillonne son propre processus et tout l'arbre de Chrome (navigateur, zygotes, renderer, GPU, utilitaires, distingués par `--type=`), puis ferme Chrome à la fin. Ne jamais pointer `--user-data-dir` vers le profil habituel.
- Le passage est invalide sans processus `chrome (renderer)` dans l'échantillonnage (pendant de la règle WebKitWebProcess). Fermer la fenêtre Chrome pendant le banc écrit un rapport partiel (code 3).
- La section « Transport » des deux rapports donne messages/s, Ko/s, taille moyenne et µs de CPU par message (backend et moteur web) : en S0 (sans xterm), c'est le coût du transport à retrancher pour comparer les moteurs.
- `--monitor` en mode web : Chrome sous Wayland natif ignore toute position de fenêtre ; il est alors lancé en **XWayland** (`--ozone-platform=x11 --window-position=<position xrandr> --start-fullscreen`), ce que le moteur et l'en-tête signalent. La page vérifie ensuite sa position (écran atteint ou non). Sans `--monitor`, Chrome reste en Wayland natif.
- Parité des deux rapports : `./compare-reports.py out/report-…A.json out/report-…B.json` met les mesures clés côte à côte et signale tout écart de conditions (devicePixelRatio, colonnes×lignes, fréquence d'images, débit, source, lots, mode, empreinte du front, écran demandé et atteint) ; code 2 s'il y en a. La fréquence d'affichage n'est jamais modifiée, seulement relevée.
- Densité de pixels : `run-bench-web.sh` force Chrome à celle de WebKitGTK (`--force-device-scale-factor`, échelle GDK de la sortie visée lue par `tauri-xterm-bench --list-monitors`) ; `--dpr N` pour une autre valeur, `--dpr 0` pour ne pas forcer. Le profil Chrome est recréé à chaque passage (démarrage à froid, comme Tauri) ; le ralentissement des fenêtres masquées et des minuteries est désactivé.
- Mode manuel : `cargo run -p bench-web` puis ouvrir `http://127.0.0.1:5180/?transport=ws`.

## Deux modes d'IPC

- **Prudent** (`--hidden-ipc on`, défaut) : les 10 sessions traversent l'IPC et le front garde 1 Mo de chacune ; en S3, l'historique est rejoué depuis ce tampon JS. C'est un majorant.
- **Réaliste** (`--hidden-ipc off`) : seules les sessions affichées traversent l'IPC (S0 : une seule, S1–S3 : la visible, S4 : les 10). Le Rust garde le dernier Mo de chaque session ; en S3, le front demande la session cible, le Rust envoie son historique par le canal (messages ≥ 1 Ko, chemin `fetch`), puis son flux direct et un marqueur ; le changement est mesuré de la demande à l'image qui suit l'écriture de l'historique et du premier lot direct. L'intégrité ne compte que les sessions envoyées (listées par passage).

Le nom du rapport est calculé par le binaire (`--print-report-name`) et n'écrase jamais un rapport précédent : `out/report[-quick]-<complet|realiste>-b<lots>[-r<débit>][-replay[-fichier]][-xN][-s<scénarios>][-<moteurs>][-<écran>][-nodmabuf][-chrome][-suffixe]-AAAAMMJJ-HHMMSS.{md,json,log}`, par exemple `out/report-realiste-b16-r2-eDP-1-chrome-20261019-150000.md`. Les marques n'apparaissent que hors des valeurs par défaut.

Codes de sortie des deux scripts : **0** RÉUSSI ou ÉCHEC (complet et valide), **4** INCOMPLET ou cases invalides, **3** rapport partiel, **1** aucun rapport ; la dernière ligne affiche le verdict et le chemin du rapport. Pendant le passage, la veille et le verrouillage sont inhibés (`gnome-session-inhibit`, sinon `systemd-inhibit`), ce que l'en-tête note. `run-bench.sh --no-build` refuse de tourner si `dist/` est plus récent que le binaire (le front y est embarqué) ; l'empreinte de `dist/` figure dans chaque rapport.

## Scénarios

| N° | Contenu | Rôle |
|---|---|---|
| S0 | Flux IPC (10 sessions en mode prudent, une en réaliste) et tampons JS, **aucun terminal** ; écho mesuré à la réception | Témoin : coût de l'IPC et de la génération, sans xterm. Informatif, une fois par répétition |
| S1 | 10 × 20 Ko/s, une session visible, frappe simulée | Usage prévu |
| S2 | S1 + pic de 5 Mo dans la session visible | Sorties massives |
| S3 | S1 + changement de session toutes les 500 ms, rejeu d'1 Mo | Barre latérale |
| S4 | 10 terminaux visibles en grille | Informatif (vue mosaïque) |

S1 à S4 sont joués avec le moteur DOM puis WebGL (ordre inversé une répétition sur deux).

## Résultats

- `out/report-complet-b10.md` (nom selon le mode, voir plus haut) : verdict, en-tête (lots IPC, part des messages < 1 Ko, charge machine, profil d'énergie), le tableau « Résultats » du spec, les critères et la validité case par case, puis chaque passage.
- `out/report-….json` : tout, y compris les séries de la file d'écriture et le CPU / la mémoire par processus.
- `out/report-….log` : la sortie de l'app (une ligne par passage).

### Verdict et validité

- **RÉUSSI** : au moins un moteur passe S1, S2 et S3 (critères évalués sur la médiane des répétitions) avec des passages tous valides. Le meilleur moteur est celui qui passe ; si les deux passent, celui au p95 d'images le plus bas.
- **ÉCHEC** : tous les moteurs ont des cases valides et complètes, et aucun ne passe.
- **INCOMPLET** : un scénario requis manque ou est invalide sans qu'un autre moteur passe, le rapport est partiel, ou le front a signalé une erreur.

Un passage est **invalide** si : erreur du front pendant le passage ; fenêtre cachée ; en WebGL, contexte non créé ou perdu (xterm retombe alors sur le DOM) ou rendu logiciel (llvmpipe, softpipe, SwiftShader) ; moins de 95 % des échos vus (hors jetons abandonnés lors d'un changement de session en S3) ; aucun processus de rendu dans l'échantillonnage CPU (`WebKitWebProcess` en Tauri, `chrome (renderer)` en mode web, plus `chrome (gpu-process)` quand WebGL est actif) ; en S0, S1 et S4, moins de 98 % des octets envoyés pendant la fenêtre reçus par la page (compté par la page à l'envoi de `mark_end`, avant toute réponse, dans les deux modes) ; avec `--monitor`, écran non atteint ou plein écran perdu ; boîte des terminaux qui ne tient pas dans la fenêtre.

Critères (spec) : images p95 ≤ 25 ms et < 2 % au-delà de 33 ms ; frappe p95 ≤ 50 ms ; pic de S2 : file de xterm vide ≤ 3 s après réception du dernier morceau (demande → reçu et demande → affiché donnés à côté) ; changement de session p95 ≤ 150 ms (p50 donné aussi) ; CPU moyen en S1 ≤ 25 % d'un cœur.

### Limites connues

- Le CPU additionne l'app (générateurs compris) et ses descendants (WebKitWebProcess, WebKitNetworkProcess… ou, en mode web, bench-web et tout l'arbre de Chrome) ; **le compositeur (gnome-shell, Xwayland) n'est pas dans le total**, il est donné à part (« hors total »). La fenêtre de mesure est alignée sur des échantillons à 1 s.
- La RSS est une somme par processus : les pages partagées sont comptées plusieurs fois.
- En mode prudent, les sessions cachées traversent quand même l'IPC (le vrai produit ne les enverrait pas : c'est le mode réaliste).
- À 20 Ko/s et des lots de 10 ms, les messages font ~200 o : Tauri les transmet par `eval` d'un tableau JSON de nombres (au-delà de 1 Ko, par `fetch` binaire). `--batch-ms 50` permet d'en mesurer l'effet.
- L'écho s'arrête au « rendu émis » (image qui suit le traitement par xterm), pas au pixel affiché.

## Fenêtre blanche, rapport jamais écrit

Sur certains couples GPU / Wayland, WebKitGTK affiche une fenêtre blanche (ou grise) avec le moteur DMA-BUF. Symptômes : la ligne d'état ne s'affiche jamais, le journal `out/report-….log` ne contient aucune ligne `[bench] passage …`, et seul le garde-fou finit par écrire un rapport partiel. Relancer avec `./run-bench.sh --no-dmabuf`, qui pose `WEBKIT_DISABLE_DMABUF_RENDERER=1` ; le rapport note cette variable dans son environnement.

## Ce que fait le banc

- **Rust** (`core/` : moteur commun aux deux modes ; `src-tauri/` : commandes Tauri ; `web/` : serveur du mode web) : 10 générateurs imitent la TUI de Claude Code (texte coloré, spinner réécrit par `\r\x1b[K`, déplacements du curseur, cadres, diffs) à ~20 Ko/s chacun. Les octets sont regroupés toutes les 10 ms et poussés par un `tauri::ipc::Channel` par session, en binaire (`InvokeResponseBody::Raw`). Le pic de 5 Mo et l'historique d'1 Mo par session sont pré-générés au démarrage et envoyés hors verrou. Un thread échantillonne chaque seconde le CPU et la mémoire de l'arbre de processus via `/proc`. Les statistiques, la validité, le verdict et les rapports sont calculés dans `core/` (`cargo test -p bench-core`).
- **Front** (`src/main.ts`, TypeScript + Vite, sans framework) : terminaux xterm.js, tampon JS d'1 Mo par session, mesures brutes (intervalles d'images, écho via un jeton `⟦k42⟧` inséré par le Rust, file d'écriture de xterm relevée à chaque écriture et à chaque image, changements de session, octets reçus par session pour le contrôle d'intégrité).

Variables utiles pour une relance ciblée : `BENCH_SCENARIOS=S2,S3`, `BENCH_RENDERERS=webgl`, `BENCH_RATE_KBPS=20`, `BENCH_SCENARIO_S=25`, `BENCH_WARMUP_S=3`.

## Mode manuel

```sh
./run-dev.sh          # tauri dev, rechargement à chaud du front
./run-dev.sh --pty    # un vrai bash dans le terminal 0 (à la place de la session simulée)
```

Barre d'outils : disposition (1 ou 10 terminaux), moteur (DOM / WebGL), « Pic 5 Mo », « Session suivante » (rejeu de l'historique), frappe simulée. La ligne d'état affiche en continu le p95 des images, l'écho, la file de xterm et le dernier changement de session.

## Vérifications sans fenêtre

```sh
cargo test -p bench-core   # générateur, rejeu, percentiles, /proc, validité, verdict, rapport
npm run typecheck && npm run build
```
