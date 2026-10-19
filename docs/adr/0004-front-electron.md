# ADR 0004 : le front des v0.x est en Electron

- Statut : accepté (2026-10-19)
- Remplace : le choix « Tauri 2 » de l'[architecture § 4.2](../architecture.md#42-app-linterface) (version du 2026-10-19 matin)
- Voir aussi : [prototype n° 2](../spikes/02-tauri-xterm.md), [ADR 0001](0001-demon-orchd.md)

## Contexte

Le prototype n° 2 a comparé, à conditions identiques (même front, même flux, 60 Hz, densité 2, terminaux 151×50, 2 Ko/s par session, 2 répétitions), Tauri 2 / WebKitGTK et Chromium, sur la machine de référence (Ubuntu 26.04, GNOME Wayland, AMD 780M) :

| Une session qui défile (S1, WebGL) | Tauri / WebKitGTK | Chromium |
|---|---|---|
| CPU | 85 % d'un cœur | 15 % |
| Frappe p95 | 76 ms | 29 ms |
| 10 terminaux affichés (S4) | effondrement (99 % d'images > 33 ms, écho 8,9 s) | 30 % de CPU, fluide |

Le diagnostic par thread montre que le GPU est bien utilisé pour dessiner, mais que 75 % d'un cœur partent dans le thread principal GTK de l'app Tauri, à l'étape où l'image de WebKit est remise à la fenêtre GTK3. C'est une limite de Tauri 2 sous Linux, pas un réglage. Une vraie session Claude Code produit 0,8 Ko/s en moyenne ; même à ce débit, Tauri ne tient pas les critères.

Trois options restaient : Electron, Tauri avec Chromium embarqué (CEF, expérimental, X11 seulement sous Linux, 200 à 450 Mo), interface native Rust (GPUI + terminal Alacritty).

## Décision

Le front des v0.x est une application **Electron** :

- **React + xterm.js (moteur WebGL)**, une seule fenêtre, un seul processus de rendu.
- Le **processus principal Electron** est le client du démon `orchd` (socket Unix, protocole de l'architecture § 14). Il relaie vers la page par `contextBridge` / `MessagePort`. La page n'a pas accès à Node (`contextIsolation`, `sandbox`, pas de `nodeIntegration`).
- **Seule la session affichée est transmise à la page** ; les historiques restent dans le démon, qui fournit l'écran courant au changement de session.
- Les octets du terminal partent par lots d'au moins ~1 Ko ou toutes les ~16 ms, en binaire.
- Les plugins à interface web s'affichent dans des iframes isolées (architecture § 19).

## Alternatives écartées

- **Tauri 2** : CPU 5 à 6 fois plus élevé à travail égal sous Linux, effondrement en mosaïque. Rédhibitoire pour un outil ouvert toute la journée.
- **Tauri + CEF** : expérimental, lié à une révision git de Tauri, X11 seulement sous Linux, aussi lourd qu'Electron.
- **Natif Rust (GPUI)** : le plus sobre (estimé 3 à 5 fois moins de CPU, 80 à 200 Mo), mais environ deux fois plus long à développer, écosystème jeune (API 0.x), et pas de moteur web : l'aperçu des apps, le `graph.html` de Graphify et les plugins à interface HTML deviendraient difficiles. Reste une option pour une version ultérieure, puisque toute la logique est dans le démon.

## Conséquences

- **Coûts acceptés** : mémoire estimée à 300 à 600 Mo réels (1,15 à 1,3 Go en somme de RSS dans le banc), installeur d'environ 85 à 100 Mo, mises à jour de sécurité de Chromium à suivre.
- **À vérifier dès le démarrage** : qu'Electron tourne en Wayland natif sur GNOME (et non via XWayland), et le CPU à 165 Hz sur l'écran du portable (non mesuré).
- **Dictée vocale** : la capture audio, la transcription locale et les raccourcis globaux, prévus côté Rust Tauri, passent dans un petit programme Rust séparé (`orch-voice`) lancé par Electron. Ils restent sur le poste même quand `orchd` sera distant. Le prototype n° 3 (raccourcis sous Wayland) reste nécessaire.
- Le banc d'essai du prototype n° 2 garde un mode Chromium réutilisable pour mesurer les évolutions du front.
