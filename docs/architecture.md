# Architecture de DevMaestro

> Statut : proposition validée le 2026-10-19. Prototype n° 1 concluant ([résultats](spikes/01-pty-hooks.md#résultats)) ; prototype n° 2 tranché en faveur d'Electron ([résultats](spikes/02-tauri-xterm.md#résultats)) ; prototypes 3 et 4 à faire (voir § 17).
> Décisions détaillées : [ADR 0001](adr/0001-demon-orchd.md), [ADR 0002](adr/0002-injection-des-hooks.md), [ADR 0003](adr/0003-permissions-depuis-l-app.md), [ADR 0004](adr/0004-front-electron.md).
> Maquettes : [`prototype/orchestrateur.html`](../prototype/orchestrateur.html).

## 1. Objet

DevMaestro est une application desktop open source pour suivre et piloter plusieurs sessions Claude Code en parallèle : statut, questions en attente, contexte, coût, diff, fichiers, tests, livraison.

L'intelligence reste dans Claude Code. L'app lance le vrai `claude` interactif dans un terminal et ajoute le suivi par-dessus. Elle ne remplace ni le modèle ni l'interface de Claude Code.

Hors périmètre v1 : sessions SSH (prévues, voir § 4.4), GitLab, suivi mobile.

## 2. Principes

1. **Ne jamais casser la configuration de l'utilisateur.** Les hooks, la statusline et les réglages existants (peon-ping par exemple) continuent de fonctionner dans les sessions lancées par l'app.
2. **Le vrai Claude Code, pas une imitation.** Le terminal affiche la TUI d'origine ; slash commands, plan mode et raccourcis restent disponibles.
3. **Local d'abord.** Aucun port réseau ouvert, aucun compte, aucune télémétrie. L'audio de la dictée ne quitte pas la machine. Seule exception : le démon interroge l'endpoint d'usage d'Anthropic avec le jeton OAuth de chaque profil pour afficher les quotas (§ 11), désactivable.
4. **Se dégrader proprement.** Une source de données absente (quotas, transcript) donne un état « inconnu », jamais une erreur bloquante.
5. **Petit périmètre, un seul domaine.** Des modules dans un bounded context, pas une multiplication de crates.

## 3. Vue d'ensemble

```
┌─────────── app (Electron) ───────────┐            ┌──────────────── orchd (démon Rust) ────────────────┐
│ UI React + xterm.js                   │  socket    │ Superviseur de sessions                             │
│  vues projet / statut, diff, fichiers │  Unix      │  ├─ PTY ×N → claude (profil perso | boulot)          │
│  réglages, thèmes, dictée             │◄──────────►│  ├─ émulateur de terminal sans affichage ×N          │
│ process principal : client du démon,  │  RPC +     │  └─ machine à états par session                      │
│  notifications, raccourcis ;          │  flux PTY  │ Runners (dev, tests) dans des PTY                    │
│  orch-voice (Rust) : audio, dictée    │            │ Git, gh, détection des commandes, SQLite             │
└───────────────────────────────────────┘            └────────────▲───────────────────────────────▲────────┘
                                                                   │ socket local + jeton           │
                                   claude ── hook ──► `orchd hook <événement>`   claude ── statusline ──► `orchd statusline`
```

## 4. Processus

### 4.1 `orchd`, le démon

Il possède tout ce qui doit survivre à l'interface : les PTY des sessions et des runners, l'état des sessions, la base SQLite. Il démarre avec l'app s'il ne tourne pas déjà (puis, en option, comme service systemd utilisateur). Fermer ou mettre à jour l'app ne tue aucune session.

### 4.2 `app`, l'interface

Application **Electron** ([ADR 0004](adr/0004-front-electron.md)) : front React, terminaux xterm.js avec le moteur WebGL, une seule fenêtre. Le processus principal Electron est le client du démon et relaie vers la page par `contextBridge` / `MessagePort` ; la page n'a pas accès à Node. Seule la session affichée est transmise à la page.

L'app porte aussi ce qui dépend du poste de travail et pas des sessions : notifications desktop, raccourcis globaux, et la dictée via `orch-voice`, un petit programme Rust (capture audio, transcription locale) lancé par Electron. Il reste local même quand `orchd` sera distant.

Tauri 2 a été écarté après mesure : sous Linux, il consomme 5 à 6 fois plus de CPU que Chromium à travail égal ([prototype n° 2](spikes/02-tauri-xterm.md)).

### 4.3 Relais des hooks et de la statusline

Sous-commandes du binaire `orchd` (`orchd hook <événement>`, `orchd statusline`), lancées par Claude Code. Elles lisent le JSON sur stdin, le transmettent au démon par le socket et, pour `PermissionRequest` uniquement, attendent la décision. Pour les autres événements, le relais attend seulement un accusé de réception (pas une décision), dans un budget court (1 s, 0,5 s pour `SessionEnd`, qui ne dispose que de 1,5 s) : les hooks d'une session sont ainsi appliqués dans l'ordre. Détails : [protocole](protocole.md#8-relais-orchd-hook-orchd-statusline).

### 4.4 Préparer SSH sans le faire

Toute commande passe par une notion d'**hôte** (`local` en v1). Plus tard, un `orchd` tournera sur la machine distante et l'app s'y connectera via un tunnel SSH ; aucune autre pièce n'aura à changer.

## 5. Modèle de domaine

| Concept | Définition |
|---|---|
| Profil | Un compte Claude : nom + `CLAUDE_CONFIG_DIR` (`~/.claude`, `~/.claude-work`). Détectés automatiquement, modifiables. |
| Projet | Un dépôt git (identifié par son dossier commun `git rev-parse --git-common-dir`). Porte : profil par défaut, emplacement des worktrees, dépôt GitHub. |
| Worktree | Un checkout d'une branche du projet. Emplacement configurable : à côté du dépôt, dans `.worktrees/`, ou dans un dossier géré par l'app. |
| Session | Un processus `claude` lancé (ou repris) par l'app dans un worktree, avec un `session_id` choisi par l'app. Peut être liée à une issue. |
| Sous-agent | Un agent lancé par Claude dans une session (outil `Agent`) : description, type, statut, durée, outils utilisés, rapport final. Alimenté par `SubagentStart` / `SubagentStop` et par les champs `agent_id` / `agent_type` des hooks (**à vérifier**, Q12 du prototype n° 1). Affiché en sous-arbre de la session et dans un onglet « Agents ». |
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
4. **Flux du terminal** : affichage uniquement, avec **une seule exception** (ajoutée après le premier essai, 2026-10-20) : le mode de permission affiché en bas de la TUI (« manual mode on », « plan mode on »…) est lu dans l'émulateur pour confirmer un changement de mode tout de suite, car Claude au repos n'envoie aucun hook. Lecture tolérante, limitée aux dernières lignes de l'écran, jamais pour les modes dangereux ; les hooks restent prioritaires. Détails dans `docs/protocole.md` (`sessions.setMode`).

Git (branche, diff, worktrees) est interrogé directement, avec une surveillance des fichiers pour rafraîchir.

## 7. Cycle de vie d'une session

**Lancement.** Le démon :

1. crée le worktree si demandé (`git worktree add <chemin> -b <branche>`) ;
2. génère un UUID de session et un jeton ;
3. lance dans un PTY, avec `cwd` = worktree :

```
CLAUDE_CONFIG_DIR=<profil>  ORCH_SOCKET=<relay.sock>  ORCH_TOKEN=<jeton>
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
- **Écrire dans une session** : les textes multi-lignes (revue, échecs de tests, dictée) partent en *bracketed paste*, sinon le premier retour à la ligne enverrait le message trop tôt. Claude Code encadre un texte collé dans une balise `<pasted_content>`, que Claude traite comme du contenu venu d'ailleurs : la **consigne est tapée** (« Voici ma revue du diff, applique-la : »), seul le contenu est collé, puis Entrée.
- **Changer de mode** : pas d'API. Le cycle de Shift+Tab est `manual` → `accept edits` → `plan` → `auto`. Le démon envoie le nombre de Shift+Tab nécessaires et vérifie le `permission_mode` du hook suivant. Contournement assumé, isolé dans un adaptateur.
- **Confiance du dossier** : enregistrée par profil. Au premier lancement d'un projet dans un profil, la TUI la demande ; l'app doit le signaler au lieu de croire la session bloquée.

## 10. Intégrations

| Sujet | Choix |
|---|---|
| Git | CLI `git` (branches, worktrees, diff, rebase, push). |
| Forge | Interface `Forge`. Adaptateur v1 : CLI `gh` (issues et sous-issues, `pr create`, `pr checks`, merge). Réutilise l'authentification de l'utilisateur, aucun token stocké. GitLab plus tard via `glab`. |
| Runners | Détection dans `package.json`, `Makefile`, `justfile`, `Cargo.toml`, `go.mod`, `docker-compose`. Exécution en PTY. Un `PORT` attribué par worktree ; les URL `localhost:` sont repérées dans les logs. |
| Aperçu web | D'abord une iframe sur `localhost` dans la page (règle CSP `frame-src`) ; vue web Electron séparée (`WebContentsView`) seulement si l'iframe ne suffit pas. |
| Fichiers | Arborescence du worktree, rendu Markdown avec sommaire, mention `@fichier` vers la session. |
| Notifications | Notification desktop par l'app ; le son reste à peon-ping. |

## 11. Quotas

Interface `QuotaSource`, résultat par profil, chaque fenêtre (5 h, 7 jours) pouvant être inconnue :

- adaptateur **statusline** (officiel) : `rate_limits.five_hour` / `seven_day`, présent seulement pour les abonnements Pro/Max et après la première réponse de l'API ;
- adaptateur **endpoint d'usage** (non documenté, celui qu'utilise déjà `/usage`) : `GET https://api.anthropic.com/api/oauth/usage` au démarrage du démon, toutes les 5 minutes et à la demande ; jeton lu dans `<profil>/.credentials.json`, jamais renouvelé, écrit ni journalisé ; activé par défaut, désactivable par `[quotas] usage_api = false`. Fusion fenêtre par fenêtre (5 h, 7 jours) : chacune garde sa lecture la plus récente, statusline ou endpoint ; une fenêtre dont la remise à zéro est passée redevient inconnue.

## 12. Dictée vocale

- Dans `orch-voice`, programme Rust local lancé par Electron : capture `cpal`, détection de parole, transcription locale. Il envoie le texte au processus principal Electron.
- Modèles : Parakeet TDT 0.6B v3 par défaut (via ONNX), Whisper via `whisper-rs`. La bibliothèque d'inférence Parakeet reste à choisir au prototype n° 4 ; licence compatible obligatoire (pas de reprise de code AGPL).
- Dictée rapide : push-to-talk ou enregistrement, au choix. Longue dictée : transcription au fil de l'eau, relecture optionnelle, préambule optionnel.
- Audio conservé seulement si demandé, en Opus/Ogg.
- Raccourcis globaux : à valider sous GNOME Wayland (prototype n° 3), en partant de la solution retenue par Murmure.

## 13. Stockage et configuration

| Quoi | Où | Format |
|---|---|---|
| État (sessions, revues, livraisons, runners) | `$XDG_DATA_HOME/devmaestro/state.db` | SQLite |
| Configuration (profils, projets, voix, raccourcis) | `$XDG_CONFIG_HOME/devmaestro/config.toml` | TOML |
| Thèmes | `$XDG_CONFIG_HOME/devmaestro/themes/*.toml` | TOML, partageables |
| Plugin Claude Code généré | `$XDG_DATA_HOME/devmaestro/claude-plugin/` | plugin Claude Code |
| Réglages générés (statusline chaînée) | `$XDG_DATA_HOME/devmaestro/settings/<profil>.json` | JSON |
| Journal du démon | `$XDG_STATE_HOME/devmaestro/orchd.log` | texte |
| Sockets | `$XDG_RUNTIME_DIR/devmaestro/orchd.sock` (contrôle) et `relay.sock` (relais), voir [protocole § 1 et § 10](protocole.md) | droits 0600 |

## 14. Protocole entre l'app et le démon

- Socket Unix, trames préfixées par leur longueur, avec un octet de type : JSON-RPC 2.0 (requêtes, réponses, notifications d'état) ou octets bruts d'un PTY (identifiant de session + données). Contrat détaillé : [protocole](protocole.md).
- L'app s'abonne aux sessions affichées ; le démon pousse les changements d'état à tous les clients.
- Côté front, le processus principal Electron relaie vers la page par `MessagePort` (octets du terminal en binaire, par lots d'au moins ~1 Ko ou toutes les ~16 ms).

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
  voice/                   binaire `orch-voice` : capture audio, transcription locale
app/                       Electron
  main/                    processus principal : client du démon, notifications, raccourcis, lancement d'orch-voice
  preload/                 pont contextBridge vers la page
  renderer/                React + xterm.js (WebGL)
docs/                      architecture, ADR, plans des prototypes
prototype/                 maquettes HTML
spikes/                    prototypes techniques jetables
```

Le domaine ne dépend d'aucun adaptateur. Les tests du domaine rejouent des événements réels.

## 17. Risques et prototypes techniques

| N° | Question | Si la réponse est non |
|---|---|---|
| 1 | Les hooks d'un plugin passé par `--plugin-dir` s'ajoutent-ils à ceux de l'utilisateur ? `PermissionRequest` peut-il attendre l'app, et que montre la TUI pendant ce temps ? La statusline se chaîne-t-elle ? `AskUserQuestion` est-il visible ? | Revoir l'ADR 0002 ou 0003 avant toute ligne de code. Plan : [spikes/01](spikes/01-pty-hooks.md). |
| 2 | ✅ Tranché : Tauri + WebKitGTK ne tient pas (CPU 5 à 6 fois celui de Chromium sous Linux, limite GTK3). Front en Electron ([ADR 0004](adr/0004-front-electron.md)). Reste à vérifier : Electron en Wayland natif, CPU à 165 Hz. | — |
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

## 19. Extensibilité par plugins (à concevoir)

Besoin exprimé le 2026-10-19 : que chacun puisse ajouter ses outils. Premiers cas :

- **Graphify** : graphe de connaissances du code (local, MIT, sorties `graph.json` / `graph.html`). Un onglet « Impact » montrerait les modules touchés par le diff d'une session, et une recherche dans le graphe.
- **API d'un projet d'équipe** : un connecteur propre à une équipe.

Piste à valider avant la v0.3 (ADR à écrire) :

- **Points d'extension** = ce qui est déjà un port ou une zone d'interface : onglets de session, panneaux latéraux, actions sur une session ou un fichier, badges dans la barre latérale, sources de données (`Forge`, `QuotaSource`…).
- **Plugin = processus séparé**, dans n'importe quel langage, qui parle JSON-RPC sur stdio avec `orchd`, et déclare ce qu'il apporte dans un manifeste. Son interface s'affiche dans une iframe isolée, avec une petite API (session courante, worktree, diff, envoyer un message à Claude).
- **Permissions déclarées** dans le manifeste (lecture du diff, écriture dans une session, réseau…) et acceptées par l'utilisateur.
- **Côté Claude** : un plugin peut aussi fournir un plugin Claude Code (skills, MCP), injecté par `--plugin-dir` comme le nôtre.

**Graphe de code (analyse d'impact)**, étudié le 2026-10-19 :

| | Graphify | CodeGraph | GitNexus |
|---|---|---|---|
| Licence | MIT | MIT | **PolyForm Noncommercial** |
| Stockage | `graph.json` / `graph.html` | SQLite local, réindexation automatique | LadybugDB |
| Impact | requêtes | `impact`, `affected` | `impact` avec confiance, `detect_changes` depuis un diff git |
| Visualisation | `graph.html` prêt à afficher | aucune | interface web |
| Accès pour l'app | lire le JSON | CLI `--json`, bibliothèque npm | CLI, MCP HTTP, serveur HTTP |

Piste retenue : un port `CodeGraphProvider` (entrée : diff d'une session ; sortie : symboles et fichiers touchés avec profondeur d'impact, recherche). **Premier adaptateur : CodeGraph** (MIT, SQLite lisible, appelable depuis Node), télémétrie désactivée et sans son installeur (qui modifie `CLAUDE.md` et les permissions) : son serveur MCP est injecté par notre plugin, session par session. **GitNexus** (licence non commerciale) et **Graphify** restent des plugins optionnels installés par l'utilisateur, jamais embarqués.

**Graphicle** (ajouté le 2026-10-19 ; Apache-2.0, binaire Rust unique, SQLite, HTTP et MCP sur 127.0.0.1, sans télémétrie) : portage en Rust du moteur de Graphify, avec en plus une **mémoire de projet** rattachée aux fonctions, marquée périmée quand le code change, et dont les entrées proposées par un agent attendent la validation d'un humain ; impact des PR via `gh`. Très jeune (version 0.1, une vingtaine de commits) et `setup` intrusif (modifie `AGENTS.md`, installe des hooks). Candidat pour un second adaptateur et pour un plugin « mémoire de projet », à réévaluer avant la v0.3.

Conséquence immédiate : garder les ports du domaine et les zones de l'interface assez génériques pour accueillir des contributions, sans construire le système de plugins avant d'en avoir deux vrais cas.

## 20. Questions ouvertes

- Licence : FSL ou AGPL + CLA (non tranché).
- Faut-il lancer `orchd` comme service systemd utilisateur dès la v0.1 ?
- Rétention des transcripts et de l'audio : durée par défaut.
