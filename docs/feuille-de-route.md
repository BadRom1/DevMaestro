# Feuille de route

> Document de suivi partagé avec l'utilisateur. Mis à jour à chaque lot livré ou à chaque retour d'essai.
> Dernière mise à jour : 2026-10-20.
> Détail des lots et contrats de protocole : [v0.1](v0.1.md), [v0.2](v0.2.md). Architecture : [architecture.md](architecture.md).

## Où on en est

Tout le travail est sur la branche locale `v0.1` (non poussée). `main` (publiée sur GitHub) ne contient que la conception et les prototypes.

| Version | État | Contenu |
|---|---|---|
| v0.1 | ✅ livrée | Démon `orchd`, sessions dans des PTY, hooks et statusline, permissions et questions depuis l'app, quotas par profil, notifications, thèmes, nouvelle session, anciennes sessions |
| v0.2 | ✅ livrée, en essai | Diff et revue, onglet Fichiers (Markdown, coloration, sélection envoyée à Claude), vue par statut (filtre, volet), sous-agents, worktrees (création, nettoyage), palette par mode |
| v0.3 | 🔜 en cours | ✅ Finitions et zoom (lot 8), ✅ commits (lot 9), ✅ vue conversation (lots 10 à 12) ; ensuite édition de fichiers (lot 7) |

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

## Prochains lots

| Lot | Contenu | Pourquoi | État |
|---|---|---|---|
| **8. Finitions d'interface** | Sélecteurs alignés (Nouvelle session : profil / modèle / mode, branche / base / emplacement) ; carte de question qui ne masque plus le contenu (zone réservée en bas, repliable) ; import d'un thème JSON ; réglages avec en-tête fixe (titre + croix toujours visibles) et coins arrondis préservés par la barre de défilement ; zoom de l'interface (Ctrl + / Ctrl − / Ctrl 0, réglage, terminal compris) | Retours de l'essai du 2026-10-20 ; accessibilité (taille de texte) | ✅ validé |
| **9. Historique des commits** | Onglet « Commits » d'une session : commits de la branche depuis la base (auteur, date, message), diff de chaque commit avec le même lecteur que l'onglet Diff, commentaire d'une ligne de commit envoyé à Claude | Suivre ce que les sessions ont commité (mode « derniers commits » pour le trunk-based) | ✅ validé |
| **7. Édition de fichiers** | Modifier un fichier depuis l'onglet Fichiers, enregistrement refusé si Claude l'a modifié entre-temps | Souhaitée, non obligatoire | 🔜 en cours |
| **Prototype n° 5. Vue conversation** | Mesures sur le transcript, voie A retenue ([ADR 0005](adr/0005-vue-conversation.md)) | Décider avant de coder | ✅ fait ([spike 05](spikes/05-vue-conversation.md)) |
| **10 à 12. Vue conversation** | Suivi du transcript par le démon, onglet « Conversation » (fil, outils, sous-agents, indicateur d'activité), saisie depuis la vue | Lire et piloter une session comme dans Claude Desktop | ✅ livré (7776f92), essai de bout en bout réussi avec un vrai `claude`, à essayer à l'écran |
| **13. GitHub** | Issues pour lancer des sessions (une par sous-issue d'un epic), suivi des PR et de la CI, **revue des PR GitHub dans l'app** | Livraison et CI ; demande « pas urgente » | ⏳ demande un ADR : aujourd'hui seule la connexion aux quotas est permise (passer par la CLI `gh` de l'utilisateur ?) |
| **14. Lancer et livrer** | Runners (dev, test) avec aperçu web, livraison (PR par l'agent ou merge sur main), suivi de CI | Fin du cycle d'une tâche | ⏳ |
| **15. Dictée** | Push-to-talk et enregistrement avec Parakeet en local, notes vocales en Opus | Prototypes n° 3 et 4 faits, branches non fusionnées | ⏳ |
| **16. Plugins** | Graphify, CodeGraph, API NLP de l'équipe | Architecture § 19 | ⏳ |
| **Paquet** | Paquet `.deb` avec profil AppArmor, lancement depuis le menu (le script `scripts/installer-lanceur-dev.sh` couvre le développement) | Utilisation sans session Claude Code, collègues | ⏳ |

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
