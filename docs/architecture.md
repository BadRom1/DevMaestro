# Architecture d'Orchestrateur

> Statut : proposition validée le 2026-10-19, à confirmer par les prototypes techniques (voir § 17).
> Décisions détaillées : [ADR 0001](adr/0001-demon-orchd.md), [ADR 0002](adr/0002-injection-des-hooks.md), [ADR 0003](adr/0003-permissions-depuis-l-app.md).
> Maquettes : [`prototype/orchestrateur.html`](../prototype/orchestrateur.html).

## 1. Objet

Orchestrateur est une application desktop open source pour suivre et piloter plusieurs sessions Claude Code en parallèle : statut, questions en attente, contexte, coût, diff, fichiers, tests, livraison.

L'intelligence reste dans Claude Code. L'app lance le vrai `claude` interactif dans un terminal et ajoute le suivi par-dessus. Elle ne remplace ni le modèle ni l'interface de Claude Code.

Hors périmètre v1 : sessions SSH (prévues, voir § 4.4), GitLab, suivi mobile.

## 2. Principes

1. **Ne jamais casser la configuration de l'utilisateur.** Les hooks, la statusline et les réglages existants (peon-ping par exemple) continuent de fonctionner dans les sessions lancées par l'app.
2. **Le vrai Claude Code, pas une imitation.** Le terminal affiche la TUI d'origine ; slash commands, plan mode et raccourcis restent disponibles.
3. **Local d'abord.** Aucun port réseau ouvert, aucun compte, aucune télémétrie. L'audio de la dictée ne quitte pas la machine.
4. **Se dégrader proprement.** Une source de données absente (quotas, transcript) donne un état « inconnu », jamais une erreur bloquante.
5. **Petit périmètre, un seul domaine.** Des modules dans un bounded context, pas une multiplication de crates.

## 3. Vue d'ensemble

```
┌──────────── app (Tauri) ─────────────┐            ┌──────────────── orchd (démon Rust) ────────────────┐
│ UI React + xterm.js                   │  socket    │ Superviseur de sessions                             │
│  vues projet / statut, diff, fichiers │  Unix      │  ├─ PTY ×N → claude (profil perso | boulot)          │
│  réglages, thèmes, dictée             │◄──────────►│  ├─ émulateur de terminal sans affichage ×N          │
│ Rust Tauri : client du démon,         │  RPC +     │  └─ machine à états par session                      │
│  capture audio, transcription,        │  flux PTY  │ Runners (dev, tests) dans des PTY                    │
│  notifications, raccourcis globaux    │            │ Git, gh, détection des commandes, SQLite             │
└───────────────────────────────────────┘            └────────────▲───────────────────────────────▲────────┘
                                                                   │ socket local + jeton           │
                                   claude ── hook ──► `orchd hook <événement>`   claude ── statusline ──► `orchd statusline`
```

## 4. Processus

### 4.1 `orchd`, le démon

Il possède tout ce qui doit survivre à l'interface : les PTY des sessions et des runners, l'état des sessions, la base SQLite. Il démarre avec l'app s'il ne tourne pas déjà (puis, en option, comme service systemd utilisateur). Fermer ou mettre à jour l'app ne tue aucune session.

### 4.2 `app`, l'interface

Application Tauri 2 : front React, terminaux xterm.js, côté Rust un client du démon. Elle porte aussi ce qui dépend du poste de travail et pas des sessions : notifications desktop, raccourcis globaux, capture audio et transcription.

### 4.3 Relais des hooks et de la statusline

Sous-commandes du binaire `orchd` (`orchd hook <événement>`, `orchd statusline`), lancées par Claude Code. Elles lisent le JSON sur stdin, le transmettent au démon par le socket et, pour `PermissionRequest` uniquement, attendent la décision. Les autres événements sont envoyés sans attendre de réponse (`SessionEnd` ne dispose que de 1,5 s).

### 4.4 Préparer SSH sans le faire

Toute commande passe par une notion d'**hôte** (`local` en v1). Plus tard, un `orchd` tournera sur la machine distante et l'app s'y connectera via un tunnel SSH ; aucune autre pièce n'aura à changer.

## 5. Modèle de domaine

| Concept | Définition |
|---|---|
| Profil | Un compte Claude : nom + `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-work`). Détectés automatiquement, modifiables. |
| Projet | Un dépôt git (identifié par son dossier commun `git rev-parse --git-common-dir`). Porte : profil par défaut, emplacement des worktrees, dépôt GitHub. |
| Worktree | Un checkout d'une branche du projet. Emplacement configurable : à côté du dépôt, dans `.worktrees/`, ou dans un dossier géré par l'app. |
| Session | Un processus `claude` lancé (ou repris) par l'app dans un worktree, avec un `session_id` choisi par l'app. Peut être liée à une issue. |
| Runner | Une commande détectée (dev, test, lint…) lancée dans un worktree, avec son port. |
| Revue | Commentaires ligne à ligne sur le diff d'une session, envoyés à Claude en un seul message. |
| Livraison | État de fin de travail : rien, PR ouverte (avec checks CI), mergée. Déclenche la proposition de nettoyage du worktree. |

### 5.1 Machine à états d'une session

| État | Entrée | Sortie typique |
|---|---|---|
| `démarrage` | PTY lancé | `SessionStart` |
| `en cours` | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, réponse donnée | `Stop`, demande de permission ou question |
| `à répondre` (permission) | `PermissionRequest`, ou `Notification` de type `permission_prompt` | décision prise |
| `à répondre` (question) | `PreToolUse` sur `AskUserQuestion` (**à confirmer**), `Notification` `elicitation_dialog` | réponse |
| `inactive` | `Stop`, `Notification` `idle_prompt` | nouveau prompt |
| `erreur` | `StopFailure`, sortie du processus avec un code non nul | relance ou reprise |
| `arrêtée` | `SessionEnd`, sortie du processus | reprise (`--resume`) |

« Terminée » dans l'interface est une information de **livraison** (PR ouverte ou mergée, ou marquée terminée), pas un état du processus.

La machine à états est du code pur, testé avec des séquences d'événements réelles capturées pendant le prototype n° 1.

## 6. Sources de données, par ordre de confiance

1. **Hooks** : état, outil en cours, permission demandée, mode (`permission_mode`).
2. **Statusline** : modèle, coût (`cost.total_cost_usd`), contexte (`context_window.used_percentage`), dossier et worktree, quotas (`rate_limits`, souvent absent).
3. **Transcript** `<config>/projects/<cwd encodé>/<session_id>.jsonl` : derniers messages, résumé, découverte des anciennes sessions. Format interne de Claude Code : lecture tolérante, optionnelle.
4. **Flux du terminal** : affichage uniquement, jamais analysé pour en déduire un état.

Git (branche, diff, worktrees) est interrogé directement, avec une surveillance des fichiers pour rafraîchir.

## 7. Cycle de vie d'une session

**Lancement.** Le démon :

1. crée le worktree si demandé (`git worktree add <chemin> -b <branche>`) ;
2. génère un UUID de session et un jeton ;
3. lance dans un PTY, avec `cwd` = worktree :

```
CLAUDE_CONFIG_DIR=<profil>  ORCH_SOCKET=<socket>  ORCH_TOKEN=<jeton>
claude --session-id <uuid> --permission-mode <mode> --model <modèle>
       --plugin-dir <plugin orchestrateur> --settings <statusline chaînée>
       "<prompt initial>"
```

**Reprise.** Même commande avec `--resume <uuid>` à la place de `--session-id` : Claude Code ne restaure ni `--plugin-dir` ni `--settings`, on les repasse toujours.

**Anciennes sessions.** Listées à partir des transcripts de chaque profil, pour reprise.

**Sessions lancées hors de l'app** (Warp, Claude Desktop) : en v1, seulement visibles comme anciennes sessions. Les suivre en direct demanderait d'installer le plugin dans la configuration de l'utilisateur, en option explicite.

## 8. Permissions et questions

Voir [ADR 0003](adr/0003-permissions-depuis-l-app.md). En résumé :

- le hook `PermissionRequest` bloque et attend la décision prise dans l'app (Autoriser, Toujours pour ce projet, Refuser) ;
- « Répondre dans le terminal » et le dépassement du délai rendent la main sans décision : Claude Code affiche sa propre demande ;
- les questions de Claude (`AskUserQuestion`) sont affichées dans l'app si le hook `PreToolUse` les voit passer ; sinon la carte renvoie vers le terminal.

## 9. Terminal

- **PTY** côté démon (crate de type `portable-pty`), un par session et par runner.
- **Émulateur sans affichage** par PTY (type `alacritty_terminal` ou `vt100`) + tampon circulaire : une UI qui se reconnecte reçoit l'écran courant puis le flux.
- **Écrire dans une session** : les textes multi-lignes (revue, échecs de tests, dictée) partent en *bracketed paste*, sinon le premier retour à la ligne enverrait le message trop tôt.
- **Changer de mode** : pas d'API. Le démon envoie Shift+Tab et vérifie le `permission_mode` du hook suivant. Contournement assumé, isolé dans un adaptateur.

## 10. Intégrations

| Sujet | Choix |
|---|---|
| Git | CLI `git` (branches, worktrees, diff, rebase, push). |
| Forge | Interface `Forge`. Adaptateur v1 : CLI `gh` (issues et sous-issues, `pr create`, `pr checks`, merge). Réutilise l'authentification de l'utilisateur, aucun token stocké. GitLab plus tard via `glab`. |
| Runners | Détection dans `package.json`, `Makefile`, `justfile`, `Cargo.toml`, `go.mod`, `docker-compose`. Exécution en PTY. Un `PORT` attribué par worktree ; les URL `localhost:` sont repérées dans les logs. |
| Aperçu web | D'abord une iframe sur `localhost` dans la webview (règle CSP `frame-src`) ; webview Tauri séparée seulement si l'iframe ne suffit pas. |
| Fichiers | Arborescence du worktree, rendu Markdown avec sommaire, mention `@fichier` vers la session. |
| Notifications | Notification desktop par l'app ; le son reste à peon-ping. |

## 11. Quotas

Interface `QuotaSource`, résultat par profil, chaque fenêtre (5 h, 7 jours) pouvant être inconnue :

- adaptateur **statusline** (officiel) : `rate_limits.five_hour` / `seven_day`, présent seulement pour les abonnements Pro/Max et après la première réponse de l'API ;
- adaptateur **endpoint d'usage** (non documenté, celui qu'utilise déjà `/usage`) : optionnel, marqué fragile, désactivable.

## 12. Dictée vocale

- Côté app (Rust Tauri) : capture `cpal`, détection de parole, transcription locale.
- Modèles : Parakeet TDT 0.6B v3 par défaut (via ONNX), Whisper via `whisper-rs`. La bibliothèque d'inférence Parakeet reste à choisir au prototype n° 4 ; licence compatible obligatoire (pas de reprise de code AGPL).
- Dictée rapide : push-to-talk ou enregistrement, au choix. Longue dictée : transcription au fil de l'eau, relecture optionnelle, préambule optionnel.
- Audio conservé seulement si demandé, en Opus/Ogg.
- Raccourcis globaux : à valider sous GNOME Wayland (prototype n° 3), en partant de la solution retenue par Murmure.

## 13. Stockage et configuration

| Quoi | Où | Format |
|---|---|---|
| État (sessions, revues, livraisons, runners) | `$XDG_DATA_HOME/orchestrateur/state.db` | SQLite |
| Configuration (profils, projets, voix, raccourcis) | `$XDG_CONFIG_HOME/orchestrateur/config.toml` | TOML |
| Thèmes | `$XDG_CONFIG_HOME/orchestrateur/themes/*.toml` | TOML, partageables |
| Plugin Claude Code généré | `$XDG_DATA_HOME/orchestrateur/claude-plugin/` | plugin Claude Code |
| Socket | `$XDG_RUNTIME_DIR/orchestrateur/orchd.sock` | droits 0600 |

## 14. Protocole entre l'app et le démon

- Socket Unix, trames préfixées par leur longueur, avec un octet de type : JSON-RPC 2.0 (requêtes, réponses, notifications d'état) ou octets bruts d'un PTY (identifiant de session + données).
- L'app s'abonne aux sessions affichées ; le démon pousse les changements d'état à tous les clients.
- Côté front, le Rust Tauri relaie vers la webview par des canaux IPC Tauri.

## 15. Sécurité

- Socket accessible au seul utilisateur, aucun port TCP.
- Un jeton par session : un hook ne peut parler que pour sa propre session.
- Le démon n'exécute que des commandes construites par lui (git, gh, runners détectés, claude) ; rien d'arbitraire venant de l'UI sans action explicite de l'utilisateur.
- Aucune donnée envoyée à l'extérieur en dehors de ce que font déjà `claude`, `git` et `gh`.

## 16. Organisation du code

```
Cargo.toml                 workspace
crates/
  core/                    lib + binaire `orchd`
    src/domain/            session (machine à états), projet, worktree, revue, livraison
    src/ports/             Pty, Vcs, Forge, QuotaSource, Store, Notifier
    src/adapters/          portable_pty, git_cli, gh_cli, sqlite, quota_statusline, quota_usage
    src/daemon/            superviseur, protocole, socket
    src/relay/             `orchd hook` et `orchd statusline`
  app/                     Tauri 2
    src/                   client du démon, audio, transcription, raccourcis, notifications
    ui/                    React + xterm.js
docs/                      architecture, ADR, plans des prototypes
prototype/                 maquettes HTML
spikes/                    prototypes techniques jetables
```

Le domaine ne dépend d'aucun adaptateur. Les tests du domaine rejouent des événements réels.

## 17. Risques et prototypes techniques

| N° | Question | Si la réponse est non |
|---|---|---|
| 1 | Les hooks d'un plugin passé par `--plugin-dir` s'ajoutent-ils à ceux de l'utilisateur ? `PermissionRequest` peut-il attendre l'app, et que montre la TUI pendant ce temps ? La statusline se chaîne-t-elle ? `AskUserQuestion` est-il visible ? | Revoir l'ADR 0002 ou 0003 avant toute ligne de code. Plan : [spikes/01](spikes/01-pty-hooks.md). |
| 2 | Tauri + WebKitGTK + xterm.js tient-il 10 sessions qui affichent en continu ? | Passer le front sur Electron, en gardant React et le démon. |
| 3 | Raccourcis globaux avec l'événement « touche relâchée » sous GNOME Wayland (le poste de référence) ? Point de départ : étudier comment Murmure a contourné ce problème (s'inspirer de l'approche, pas du code, qui est sous AGPL). | Push-to-talk seulement quand la fenêtre a le focus ; mode enregistrement en global. |
| 4 | Parakeet en Rust sur la machine de référence : latence, CPU ou GPU ? | Whisper par défaut. |

## 18. Versions

| Version | Contenu |
|---|---|
| v0.1 | Lancer et reprendre des sessions, 2 profils, vue par projet, statuts, réponse aux permissions, notifications, thèmes |
| v0.2 | Relecture du diff, onglet Fichiers et Markdown, vue par statut |
| v0.3 | Issues GitHub, cycle de vie des worktrees, runners et aperçu web |
| v0.4 | Livraison : PR, merge dans main, suivi de la CI |
| v0.5 | Dictée vocale |

## 19. Questions ouvertes

- Licence : FSL ou AGPL + CLA (non tranché).
- Faut-il lancer `orchd` comme service systemd utilisateur dès la v0.1 ?
- Rétention des transcripts et de l'audio : durée par défaut.
