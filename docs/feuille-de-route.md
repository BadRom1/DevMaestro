# Feuille de route

> Document de suivi partagé avec l'utilisateur. Mis à jour à chaque lot livré ou à chaque retour d'essai.
> Dernière mise à jour : 2026-10-21.
> Détail des lots et contrats de protocole : [v0.1](v0.1.md), [v0.2](v0.2.md). Architecture : [architecture.md](architecture.md).

## Où on en est

Tout le travail est sur la branche locale `v0.1` (non poussée). `main` (publiée sur GitHub) ne contient que la conception et les prototypes.

| Version | État | Contenu |
|---|---|---|
| v0.1 | ✅ livrée | Démon `orchd`, sessions dans des PTY, hooks et statusline, permissions et questions depuis l'app, quotas par profil, notifications, thèmes, nouvelle session, anciennes sessions |
| v0.2 | ✅ livrée, en essai | Diff et revue, onglet Fichiers (Markdown, coloration, sélection envoyée à Claude), vue par statut (filtre, volet), sous-agents, worktrees (création, nettoyage), palette par mode |
| v0.3 | 🔜 en cours | ✅ Finitions et zoom (lot 8), ✅ commits (lot 9), ✅ vue conversation (lots 10 à 12), ✅ édition de fichiers (lot 7) |

### Commits de la branche `v0.1`

| Commit | Contenu |
|---|---|
| `4a1c771` | Plan de la v0.1 et consignes du projet |
| `cc9824f` | v0.1 lot 1 : socle Rust, domaine, machine à états |
| `16aafae` | v0.1 lot 2 : démon, PTY, relais |
| `1b2816e` | v0.1 lot 3 : permissions, questions, sécurité du démon |
| `08df3ff` | v0.1 lot 4 : front Electron |
| `538f3aa` `7ce5721` `33c7b42` | Retours des premiers essais |
| `752f0f1` | v0.1 lot 5 : notifications, réglages, thèmes, nouvelle session, profils |
| `fe4ae0d` | v0.2 lot 1 : diff et revue |
| `a76db94` | v0.2 lots 3 et 4 : Fichiers, vue par statut |
| `08828c5` | v0.2 lot 5 : sous-agents |
| `32b25ba` | v0.2 lot 3 bis : coloration, sélection envoyée à Claude |
| `954ba26` | v0.2 lot 6 : worktrees ; filtre et volet du kanban, palette par mode, numéros de ligne |

## Point de reprise (2026-10-21, soir)

Tout est commité sur `v0.1`. **Le démon tourne encore sur le code de ce matin** (non redémarré, tu l'utilises) ; l'app se relance seule sans arrêter les sessions (`pnpm -C app start`).

Livré aujourd'hui, à essayer :
- **Terminal** : Maj+Entrée = retour à la ligne.
- **14a** runners et aperçu web ; **14b** livraison (PR par l'agent ou fusion) et suivi de CI.
- **15** retours sur la forge ; **15 bis** arborescence, compteurs +/−, j/k dans Commits, `l` pour « vu » ; **15 ter** changer de compte (et choix du profil à la reprise, anciennes sessions sans doublons).
- **16** colonnes redimensionnables, grille de 1 à 4 zones ; **17** slash commands ; **18** consignes personnalisables (Réglages → Consignes) ; **19** revue assistée par IA ; **20** interface FR/EN (Réglages → Général → Langue).
- **Reprise** depuis le dossier de départ de la conversation.

Actifs seulement après redémarrage du démon (arrête les sessions) : forge et CI du 14b, empreinte des runners du 15, reprise depuis le bon dossier, commandes `/` du disque (17), consigne de revue personnalisée (18).

Restent : 13c (presque entièrement couvert par 13a, 13b et 14b : à revoir), 21 dictée, 22 plugins, paquet `.deb`.

## Point de reprise précédent (2026-10-20, soir)

Travail fait en autonomie pendant ton absence, tout commité sur `v0.1` et démon + app redémarrés :

- **Vue conversation** (lots 10 à 12, [ADR 0005](adr/0005-vue-conversation.md)) : onglet « Conversation » (fil, outils dépliables, diff d'Edit, sous-agents, compaction, `/clear`), indicateur d'activité, saisie. Essai de bout en bout réussi avec un vrai `claude` piloté par le socket du démon.
- **Édition de fichiers** (lot 7) : bouton « Modifier » dans l'onglet Fichiers, CodeMirror, Ctrl+S, conflit si Claude a modifié le fichier (différences, recharger, écraser).
- **Finitions visuelles** après captures hors écran : fil ouvert en bas, contrastes ≥ 4,5:1 partout (clair, sombre, Okabe-Ito, contraste élevé, couleurs personnalisées, terminal), plus de ligatures dans le code, zoom 150 % propre, libellés et petits défauts.

À essayer en priorité : l'onglet Conversation sur une vraie session (lecture, saisie, sous-agents), l'édition d'un fichier pendant que Claude travaille, l'apparence générale (les textes secondaires sont plus foncés).

Prochaines étapes proposées (dans l'ordre) : décider l'accès réseau pour GitHub (ADR, lot 13) ; lancer et livrer (lot 14) ; paquet `.deb` ; dictée (fusion des prototypes n° 3 et 4).

## Prochains lots

| Lot | Contenu | Pourquoi | État |
|---|---|---|---|
| **8. Finitions d'interface** | Sélecteurs alignés (Nouvelle session : profil / modèle / mode, branche / base / emplacement) ; carte de question qui ne masque plus le contenu (zone réservée en bas, repliable) ; import d'un thème JSON ; réglages avec en-tête fixe (titre + croix toujours visibles) et coins arrondis préservés par la barre de défilement ; zoom de l'interface (Ctrl + / Ctrl − / Ctrl 0, réglage, terminal compris) | Retours de l'essai du 2026-10-20 ; accessibilité (taille de texte) | ✅ validé |
| **9. Historique des commits** | Onglet « Commits » d'une session : commits de la branche depuis la base (auteur, date, message), diff de chaque commit avec le même lecteur que l'onglet Diff, commentaire d'une ligne de commit envoyé à Claude | Suivre ce que les sessions ont commité (mode « derniers commits » pour le trunk-based) | ✅ validé |
| **7. Édition de fichiers** | Modifier un fichier depuis l'onglet Fichiers, enregistrement refusé si Claude l'a modifié entre-temps | Souhaitée, non obligatoire | ✅ livré, à essayer |
| **Prototype n° 5. Vue conversation** | Mesures sur le transcript, voie A retenue ([ADR 0005](adr/0005-vue-conversation.md)) | Décider avant de coder | ✅ fait ([spike 05](spikes/05-vue-conversation.md)) |
| **10 à 12. Vue conversation** | Suivi du transcript par le démon, onglet « Conversation » (fil, outils, sous-agents, indicateur d'activité), saisie depuis la vue | Lire et piloter une session comme dans Claude Desktop | ✅ livré (7776f92), essai de bout en bout réussi avec un vrai `claude`, à essayer à l'écran |
| **13a. Forge : issues et epics** | Port « forge » ([ADR 0006](adr/0006-port-forge.md)), GitHub par `gh` : panneau Issues d'un projet, lancer une session depuis une issue (consigne tapée, corps collé, avertissement), une session par sous-issue d'un epic, issue affichée sur la session | Lancer le travail depuis les issues | ✅ livré, à essayer (le dépôt DevMaestro n'a pas encore d'issue : essaie sur optimus) |
| **13b. Forge : demandes de fusion, CI et revue** | Liste et détail des demandes de fusion (CI, décision de revue, fils existants, diff), revue publiée sur GitHub depuis l'app (brouillon séparé, aperçu exact, confirmation, conflit de tête), PR + CI sur la session | Suivre les PR et relire dans l'app | ✅ livré, à essayer |
| **15. Retours sur la forge** | Filtres alignés : état en liste, **étiquettes choisies dans la liste du dépôt** (plusieurs), recherche ; **cases à cocher Markdown** (`- [ ]`, `- [x]`) rendues comme des cases dans toutes les vues Markdown ; panneau Forge redimensionnable et plein écran ; bouton « Lancer une session » visible en bas du détail de l'issue, distinct des étiquettes ; **nom de session et branche courts** (« #42 Titre court », branche `42-mot-mot-mot`) | Retours de l'essai du 2026-10-21 | ✅ livré (avec l’empreinte des runners sur les fichiers entiers et la reprise depuis le dossier de départ) |
| **15 bis. Arborescence dans le diff** | Liste des fichiers du lecteur de diff (Diff, Commits, demandes de fusion) affichable en arborescence à la demande : bascule Liste / Arborescence mémorisée, dossiers repliables avec compteurs +/− et commentaires, j/k dans l’ordre de l’arbre ; **nombre de changements (+/−) affiché en tête du fichier ouvert** ; **j/k aussi dans Commits** ; **raccourci `l` pour marquer le fichier comme vu** | Retour de l'essai du 2026-10-21 | ✅ livré, à essayer |
| **15 ter. Changer de compte** | Action « Changer de compte… » sur une session : choix du profil, attente du repos si Claude travaille, arrêt puis reprise immédiate de la même conversation sous l’autre profil (même onglet, dossier, branche, worktree) ; vérifie que le profil voit la conversation (`projects/` partagé) sinon refus clair ; suggestion depuis l’indicateur de quotas quand un compte est au plafond. (Déjà livré : choix du profil à la reprise, anciennes sessions sans doublons.) | Deux comptes aux quotas séparés | ✅ livré, à essayer |
| **16. Disposition** | Colonnes gauche et droite redimensionnables (mémorisées) ; onglets d'une session (Conversation, Terminal, Diff, Commits, Fichiers, Agents, Lancer) détachables dans une **grille de 1 à 4 zones**, à la manière de VS Code (glisser-déposer ou menu « ⋯ » de la zone), disposition globale mémorisée, « Réinitialiser la disposition » | Grands écrans | ✅ livré, à essayer |
| **17. Slash commands dans la conversation** | Liste et complétion des commandes disponibles (intégrées, `~/.claude/commands`, `.claude/commands` du projet, plugins) dans le champ de saisie | Retours de l'essai du 2026-10-21 | ✅ livré, à essayer (redémarrer `orchd` pour les commandes du disque ; sinon intégrées seules) |
| **18. Consignes personnalisables** | Tous les prompts automatiques (revue du diff, extraits de fichiers, issue, livraison, échec de CI) modifiables dans les réglages, globalement et par projet, avec variables et aperçu | Retours de l'essai du 2026-10-21 | ✅ livré, à essayer (redémarrer `orchd` pour la consigne de revue et d'extraits ; sinon celle du démon) |
| **19. Revue assistée par IA** | Depuis une demande de fusion (ou un diff, un commit) : « Revue assistée » qui ouvre directement une session en lecture seule (mode plan) sur la branche, avec le diff en contexte, pour demander des explications et des retours, sans passer par « Nouvelle session » | Retours de l'essai du 2026-10-21 | ✅ livré, à essayer (front seul, compatible avec le démon en service ; PR d'une fourche ou jamais récupérée : `git fetch origin pull/<n>/head` d'abord, ou « Lancer sans worktree ») |
| **20. Langues** | Interface en français et en anglais (choix dans les réglages, langue du système par défaut) ; messages du démon par codes traduits côté app | Partage avec d'autres utilisateurs | ✅ livré, à essayer (front seul, compatible avec le démon en service : ses textes libres restent en français, marqués en anglais ; Réglages → Général → Langue) |
| **13c. GitHub (suite)** | Issues pour lancer des sessions (une par sous-issue d'un epic), suivi des PR et de la CI, **revue des PR GitHub dans l'app** | Livraison et CI ; demande « pas urgente » | ⏳ demande un ADR : aujourd'hui seule la connexion aux quotas est permise (passer par la CLI `gh` de l'utilisateur ?) |
| **14. Lancer et livrer** (14a runners et aperçu web ; 14b livraison et CI) | Runners (dev, test) avec aperçu web, livraison (PR par l'agent ou merge sur main, consignes typées modifiables par projet), suivi de CI (état sur la session, notification d'échec, « Envoyer l'échec à Claude » avec le journal collé comme donnée) | Fin du cycle d'une tâche | ✅ livré, à essayer (14b : sur un projet avec GitHub Actions) |
| **21. Dictée** | Push-to-talk et enregistrement avec Parakeet en local, notes vocales en Opus | Prototypes n° 3 et 4 faits, branches non fusionnées | ⏳ |
| **22. Plugins** | Plugins en processus séparés, interface déclarative (ADR 0007) ; 22a : hôte dans `orchd` (manifeste, empreinte et acceptation, processus supervisé), onglet de session déclaratif, « Envoyer à Claude », plugin de référence CodeGraph (impact du diff) | Architecture § 19, ADR 0007 | 22a ✅ livré, à essayer (redémarrer `orchd` ; installer le plugin par lien symbolique, voir `plugins/codegraph-impact/README.md`) ; suite : forge GitLab par `glab`, API de l'équipe |
| **Paquet** | Paquet `.deb` avec profil AppArmor, lancement depuis le menu (le script `scripts/installer-lanceur-dev.sh` couvre le développement) | Utilisation sans session Claude Code, collègues | ✅ livré, à essayer : `scripts/paquet-deb.sh` puis `sudo apt install ./dist/devmaestro_0.1.0_amd64.deb` (menu « DevMaestro » ; arrêter d'abord un `orchd` de développement en service pour passer au démon installé ; `claude` doit être dans le `PATH` de la session graphique, sinon `DEVMAESTRO_CLAUDE_BIN`) |

## Questions ouvertes

- **Licence** : FSL ou AGPL + CLA (open source sans revente par un tiers).
- **Publication** : quand pousser `v0.1` sur GitHub (après anonymisation, comme `main`).
- **Prototypes n° 3 et 4** (raccourcis, Parakeet) : branches `refs/heads/claude/spike-03-raccourcis-fcc039` et `refs/heads/claude/spike-04-parakeet-eb8631`, à fusionner quand la dictée commence.
- **GitHub** : accès réseau à décider (ADR) avant le lot 13.
- Questions de comportement du vrai CLI encore à vérifier : voir la fin de [v0.1.md](v0.1.md).

## Retours d'essai traités

| Date | Retour | Où |
|---|---|---|
| 2026-10-20 | Notifications, diff et commentaires | v0.1 lot 5, v0.2 lot 1 |
| 2026-10-20 | Coloration, sélection envoyée à Claude, cases des réglages | v0.2 lot 3 bis |
| 2026-10-20 | Numéros de ligne décalés, filtre et volet du kanban, palette par mode | v0.2 lot 6 |
| 2026-10-20 | Alignements, carte de question, import de thème, réglages, zoom | lot 8 |
| 2026-10-20 | Historique des commits, revue des PR GitHub | lots 9 et 13 |
