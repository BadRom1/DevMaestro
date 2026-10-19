# Prototype n° 2 : Tauri, WebKitGTK et xterm.js sous charge

- Objectif : vérifier que Tauri 2 (webview WebKitGTK sous Linux) avec xterm.js tient la charge d'une dizaine de sessions, avant de figer le front ([architecture § 4.2](../architecture.md#42-app-linterface)). Si non : front sur Electron, en gardant le reste.
- Outillage jetable : [`spikes/02-tauri-xterm/`](../../spikes/02-tauri-xterm/).
- Machine de référence : Framework 16, Ryzen (16 threads), GPU AMD Phoenix intégré, 64 Go, Ubuntu 26.04, GNOME Wayland.

## Ce qu'on mesure, et pourquoi sans regarder l'écran

Le banc d'essai lance des scénarios automatiques et écrit ses mesures dans un fichier. On peut ainsi l'analyser sans observer la fenêtre.

| Mesure | Comment | Ce qu'elle dit |
|---|---|---|
| Fluidité | Intervalles entre images (`requestAnimationFrame`) : médiane, p95, p99, part des images au-delà de 33 ms | L'interface saccade-t-elle pendant que les terminaux défilent ? |
| Réactivité à la frappe | Touche simulée → écho par le backend → instant où xterm l'a affichée | Taper dans une session reste-t-il instantané ? |
| Débit | Octets produits par le backend vs octets écrits dans xterm, et file d'attente d'écriture de xterm | Le front suit-il, ou accumule-t-il du retard ? |
| Changement de session | Temps pour afficher une autre session en rejouant son historique (1 Mo) | Passer d'une session à l'autre est-il immédiat ? |
| Coût machine | CPU et mémoire du processus de l'app et du processus WebKit, échantillonnés via `/proc` | L'app reste-t-elle légère en tâche de fond ? |

## Source des données

Les sessions sont simulées par un générateur côté Rust, dans le processus Tauri (le démon n'est pas l'objet de ce prototype). Le flux imite la TUI de Claude Code : texte coloré, spinner qui réécrit la même ligne (`\r`, `\x1b[K`), déplacements du curseur, et défilement à débit réglable. Une option permet aussi de brancher un vrai PTY (`bash`, `claude`) dans un des terminaux.

Le Rust envoie les octets à la webview par un canal IPC de Tauri, regroupés toutes les ~10 ms, comme le fera le vrai client du démon.

## Scénarios

| N° | Scénario | Pourquoi |
|---|---|---|
| S1 | **Réaliste** : 10 sessions à ~20 Ko/s, **une seule visible** (les autres reçoivent leurs octets en mémoire sans terminal affiché), frappe simulée dans la visible | C'est l'usage prévu : on regarde une session à la fois |
| S2 | **Pic** : comme S1, la session visible reçoit 5 Mo d'un coup (un `cat` de gros fichier) | Les sorties massives (logs, tests) |
| S3 | **Changements** : S1 + changement de session visible toutes les 500 ms, avec rejeu d'1 Mo d'historique | Naviguer dans la barre latérale |
| S4 | **Pire cas** : 10 terminaux **affichés en même temps** (grille), ~20 Ko/s chacun | Marge de sécurité, et une éventuelle vue mosaïque |

Chaque scénario est joué avec les deux moteurs de rendu de xterm.js : **DOM** et **WebGL** (le moteur WebGL est le plus rapide, mais WebKitGTK ne l'accélère pas toujours bien).

## Critères de réussite

Sur S1, S2 et S3, avec le meilleur des deux moteurs :

- fluidité : p95 des intervalles entre images ≤ 25 ms, moins de 2 % d'images au-delà de 33 ms ;
- frappe : p95 de l'écho ≤ 50 ms ;
- débit : la file d'attente de xterm revient à zéro après le pic de S2 en moins de 3 s ;
- changement de session : p95 ≤ 150 ms ;
- CPU de l'app (tous processus) en S1 ≤ 25 % d'un cœur en moyenne.

S4 est informatif : un échec ne remet pas Tauri en cause, il interdit seulement la vue mosaïque.

Si les critères échouent : relancer le même front dans Chromium (via `cargo tauri dev` remplacé par un serveur local) pour savoir si le problème vient de WebKitGTK ou de notre code, puis décider Tauri vs Electron.

## Déroulé

1. Installer les prérequis Linux de Tauri 2 (`libwebkit2gtk-4.1-dev`, etc.).
2. `run-bench.sh` construit l'app en mode release et lance tous les scénarios (environ 5 min). **La fenêtre doit rester visible et au premier plan** : WebKit ralentit les fenêtres cachées.
3. Le rapport est écrit dans `out/report.json` et résumé dans `out/report.md`.

## Résultats

### Premiers passages (2026-10-19), non concluants

Trois passages : rapide prudent (8 s par scénario), complet réaliste (`--hidden-ipc off --batch-ms 16`), complet prudent (arrêté). **La machine était chargée par d'autres processus** pendant les passages complets (charge moyenne 1,6 → 16,7 ; un `node` à 113 %, Murmure à 42 %, headroom à 22 %) : les chiffres de S3 et S4 complets sont faussés.

Ce qu'on peut déjà retenir :

1. **WebGL est indispensable.** Il fonctionne sous WebKitGTK 2.52.6 (contexte valide sur les 10 terminaux de S4) et divise le CPU par deux par rapport au moteur DOM. En mosaïque, le DOM décroche (45 à 60 % d'images > 33 ms) ; WebGL tient (0,2 % au passage rapide).
2. **Fluidité, frappe, pic, intégrité : bons sur machine calme.** Passage rapide WebGL : images p95 17 ms, frappe p95 24 à 29 ms, pic de 5 Mo vidé en 86 ms, changement de session p95 46 ms, 100 % des octets reçus, aucun écho perdu.
3. **Le CPU est le vrai sujet.** Une seule session affichée à 20 Ko/s en continu coûte environ 50 % d'un cœur en WebGL (WebKitWebProcess ~36 %, app ~17 %). Le témoin S0 montre que le transport compte : 32 % en mode prudent (10 sessions par IPC), 12 % en mode réaliste (une seule).
4. **Le chemin IPC des petits messages est coûteux.** Sous 1 Ko, Tauri passe par un `eval` JavaScript ; 99 % des messages du banc le prennent. Le vrai produit devra envoyer des lots plus gros (≥ 1 Ko, chemin binaire) ou passer par un autre canal.

### Débit réel d'une session Claude Code (2026-10-19)

Mesuré avec `ptyhost.py` du prototype n° 1 (compteur par seconde + capture brute rejouable dans [`spikes/01-pty-hooks/fixtures/`](../../spikes/01-pty-hooks/fixtures/)). Tâche : lire l'architecture et les ADR, lancer un `ls -laR`, rédiger une synthèse de 400 mots ; mode auto, Claude Code 2.1.303.

| Phase | Débit |
|---|---|
| Travail (72 s) | moyenne **0,8 Ko/s**, médiane 0,7 Ko/s, p95 1,3 Ko/s, pointe 8,1 Ko/s ; 54 Ko au total |
| Repos (60 s après `Stop`) | **0 octet** |

Le banc simulait 20 Ko/s en continu par session, soit environ 25 fois la réalité. Les critères de CPU doivent être évalués à un débit réaliste (2 Ko/s, marge × 2,5), en gardant 20 Ko/s comme test de stress.

### Tauri/WebKitGTK contre Chrome, à parité (2026-10-19, 15 h 30)

Même front (empreinte `b1ba3058…`), même flux, 10 sessions à **2 Ko/s**, seule la session affichée transmise, lots de 16 ms, plein écran sur la BenQ `DP-3` à 60 Hz, densité 2, terminaux 151×50 (S4 : 33×29), 2 répétitions, médianes. Le comparateur de rapports ne signale **aucun écart de conditions**. Chrome tourne sous XWayland (nécessaire pour cibler l'écran).

| Scénario · moteur | CPU Tauri | CPU Chrome | Frappe p95 Tauri / Chrome | Images > 33 ms Tauri / Chrome |
|---|---|---|---|---|
| S0 (témoin, sans terminal) | 16 % | 8 % | 29 / 16 ms | 0 / 0 % |
| S1 · WebGL | **85 %** | **15 %** | **76 / 29 ms** | 0,2 / 0 % |
| S2 · WebGL (pic 5 Mo) | 88 % | 16 % | 83 / 32 ms | 1,0 / 0 % |
| S3 · WebGL (changements) | 111 % | 29 % | 100 / 30 ms | **11 / 0 %** |
| S4 · WebGL (10 terminaux) | 126 %, invalide (84 % des octets reçus) | 30 % | **8,9 s** / 35 ms | **99,5 / 0 %** |
| S1 · DOM | 92 % | 21 % | 76 / 30 ms | 0,6 / 0 % |

Lecture :

- **Chrome passe tous les critères ; Tauri/WebKitGTK échoue** (CPU, frappe au-delà de 50 ms, saccades en S3, effondrement en S4).
- Le surcoût n'est **pas dans le moteur web lui-même** : par message, le processus de rendu coûte autant des deux côtés (≈ 6,7 ms en WebGL). Il est dans le **processus de l'app Tauri** (≈ 38 ms de CPU par message contre ≈ 1 ms pour le serveur WebSocket), c'est-à-dire côté interface GTK de WebKitGTK (composition, présentation), plus le passage IPC.
- Sur l'écran du portable à 165 Hz (essai court, 2 Ko/s), Tauri montait à 63 % sur S1 contre 14 % pour Chrome à 60 Hz : la fréquence aggrave le coût côté WebKitGTK.

Passages non faits (campagne interrompue pour libérer la machine) : 20 Ko/s des deux côtés, Tauri à 165 Hz complet. Ils ne changeraient pas le sens du résultat.

### Diagnostic par thread (2026-10-19, 16 h 20)

S1 · WebGL à 2 Ko/s sur `DP-3`, CPU relevé par thread via `/proc` pendant 15 s (sans `perf`) :

| Processus | CPU | Détail |
|---|---|---|
| App Tauri | 76 % | **75 % dans le thread principal GTK** |
| WebKitWebProcess | 11 % | thread principal 7,5 %, compositeur < 1 % |

- **Le GPU est bien utilisé pour dessiner** : WebKit charge Mesa `libgallium` et `dri_gbm` (pilote AMD), aucun thread `llvmpipe` (rendu logiciel).
- **Le coût est dans le thread principal GTK de l'app**, à l'étape où l'image produite par WebKit est remise à la fenêtre GTK3. Il croît avec le nombre d'images affichées (S0 sans terminal : 16 % ; S1 : 85 %) et avec la surface × fréquence de l'écran. C'est le profil d'une recopie de chaque image par le processeur côté GTK3. Déduction cohérente avec toutes les mesures, non prouvée au niveau des fonctions (il faudrait `perf` avec `sudo`).
- **Conclusion** : limite structurelle de Tauri 2 sous Linux (lié à GTK3 ; le passage à GTK4 n'est pas disponible). Pas un réglage manquant. Note : `WEBKIT_DISABLE_DMABUF_RENDERER=1` aggraverait le problème (rendu entièrement logiciel sur WebKitGTK récent), ce n'est donc pas une piste.

| Scénario | Moteur | Images p95 / > 33 ms | Frappe p95 | File max / retour à zéro | Changement | CPU moyen | Verdict |
|---|---|---|---|---|---|---|---|
| S1 | DOM | | | | — | | |
| S1 | WebGL | | | | — | | |
| S2 | DOM | | | | — | | |
| S2 | WebGL | | | | — | | |
| S3 | DOM | | | | | | |
| S3 | WebGL | | | | | | |
| S4 | DOM | | | | — | | |
| S4 | WebGL | | | | — | | |
