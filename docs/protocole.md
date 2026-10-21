# Protocole du socket d'`orchd`

> Contrat entre le démon `orchd` et ses clients : le front Electron (lot 4), le client de mise au point `orchd ctl` et les relais `orchd hook` / `orchd statusline`.
> Version du protocole : **1** (renvoyée par `hello`). Code : `crates/core/src/protocol/`, `crates/core/src/daemon/server.rs`.
> Références : [architecture § 4, § 7, § 9, § 14, § 15](architecture.md), [ADR 0001](adr/0001-demon-orchd.md), [ADR 0002](adr/0002-injection-des-hooks.md), [ADR 0003](adr/0003-permissions-depuis-l-app.md).

## 1. Transport

Deux sockets Unix dans `$XDG_RUNTIME_DIR/devmaestro/` (repli si la variable est absente : `$TMPDIR/devmaestro-<uid>/`, sinon `/tmp/devmaestro-<uid>/`). Le dossier est en `0700`, les sockets en `0600`. Aucun port TCP.

| Socket | Qui s'y connecte | Trames acceptées | Contrôle |
|---|---|---|---|
| `orchd.sock` (contrôle) | le front, `orchd ctl` | JSON-RPC (`0x01`), entrée de PTY (`0x03`) | contrôle du pair à l'acceptation (§ 10) ; refus = connexion fermée sans réponse |
| `relay.sock` (relais) | `orchd hook`, `orchd statusline` (lancés par Claude Code) | hook (`0x10`), statusline (`0x11`) | jeton de la session dans chaque trame, et le pair doit être un processus de cette session (§ 10) ; sinon la trame est ignorée (l’expéditeur reçoit quand même l’accusé `0x12`, « sans décision » pour un `PermissionRequest`) |

Sur les **deux** sockets, une trame d'un type **inconnu** est ignorée (compatibilité ascendante) ; une trame d'un type **connu** mais inattendu sur ce socket (par exemple JSON-RPC sur `relay.sock`, hook sur `orchd.sock`, ou une trame que seul le démon envoie : `0x02`, `0x12`, `0x13`) **ferme la connexion**.

Seul le chemin de `relay.sock` est passé aux processus `claude` (`ORCH_SOCKET`).

- Un seul démon par utilisateur : verrou `flock` sur `orchd.lock` dans le même dossier. Un second `orchd daemon` sort aussitôt en erreur (« un autre démon orchd tourne déjà »).
- Le chemin du socket doit tenir dans `sun_path` (108 octets sous Linux).

## 2. Trames

Chaque message est une trame :

```
┌──────────────────────┬──────────┬──────────────────────────┐
│ longueur : u32 (BE)  │ type: u8 │ charge utile             │
└──────────────────────┴──────────┴──────────────────────────┘
```

- `longueur` compte les octets **qui suivent** : l'octet de type plus la charge utile (une trame vide de charge vaut donc `1`).
- `longueur` vaut au moins 1 et au plus 16 Mio ; au-delà, le démon ferme la connexion.
- Un type inconnu est ignoré par le destinataire (compatibilité ascendante) ; un type connu inattendu sur un socket ferme la connexion (§ 1).
- Une trame mal formée (longueur nulle ou trop grande, UUID tronqué, chaîne de hook tronquée ou non UTF-8, trame coupée) **ferme la connexion** : le démon ne cherche pas à se resynchroniser au milieu d'un flux.

| Type | Nom | Sens | Charge utile |
|---|---|---|---|
| `0x01` | JSON-RPC | les deux | un message JSON-RPC 2.0, en UTF-8 |
| `0x02` | sortie PTY | démon → client | UUID de session (16 octets, ordre RFC 4122) + octets bruts du terminal |
| `0x03` | entrée PTY | client → démon | UUID de session (16 octets) + octets à écrire dans le terminal (touches, collage) |
| `0x10` | hook | relais → démon | jeton, nom d'événement, JSON brut (voir ci-dessous) |
| `0x11` | statusline | relais → démon | jeton, JSON brut |
| `0x12` | accusé | démon → relais | vide ; après un hook ou une statusline (appliqués ou ignorés) ; pour `PermissionRequest` : relais libéré **sans décision** |
| `0x13` | décision | démon → relais | JSON de sortie du hook `PermissionRequest`, à écrire tel quel (§ 8) |

Chaînes des trames `0x10` et `0x11` : longueur `u16` gros-boutiste puis octets UTF-8.

```
0x10 : [u16 len][jeton][u16 len][événement][JSON du hook, jusqu'à la fin]
0x11 : [u16 len][jeton][JSON de la statusline, jusqu'à la fin]
```

Exemple : un hook `Stop` avec le jeton `t` et le JSON `{}` s'écrit `00 00 00 0c 10 00 01 74 00 04 53 74 6f 70 7b 7d`.

Les octets d'un PTY ne sont **jamais** analysés par le démon pour en déduire un état (architecture § 6) : ils servent à l'affichage. **Seule exception**, étroite : l'indicateur de mode du pied de la TUI, lu pour confirmer `sessions.setMode` (§ 4, « Changer de mode »).

## 3. JSON-RPC 2.0

- Requêtes `{"jsonrpc":"2.0","id":…,"method":…,"params":{…}}`, réponses `result` ou `error` avec le même `id`. Une requête sans `id` est une notification : traitée, sans réponse. Pas de lots (tableaux).
- Les requêtes d'une connexion sont traitées **dans l'ordre**, avec une exception : un `sessions.setMode` qui attend la confirmation d'un changement précédent (§ 4) est mis de côté, et les requêtes suivantes passent sans l'attendre ; sa réponse peut donc arriver après les leurs (l'`id` les distingue).
- Les notifications du démon (§ 5) ne sont envoyées qu'aux connexions qui ont envoyé au moins un message JSON-RPC (en pratique : `hello` d'abord).

### Codes d'erreur

| Code | Sens |
|---|---|
| `-32700` | JSON illisible |
| `-32600` | requête sans `method` |
| `-32601` | méthode inconnue (ou pas encore disponible) |
| `-32602` | paramètres invalides (message en français) |
| `-32603` | erreur interne |
| `-32001` | session inconnue |
| `-32002` | état incompatible (session qui tourne encore, qui ne tourne pas, démon qui s'arrête, file d'entrée pleine) |
| `-32003` | profil inconnu |
| `-32004` | lancement impossible (binaire `claude` introuvable, écriture du plugin, PTY) |
| `-32005` | mode dangereux refusé : `bypassPermissions` ou `dontAsk` sans `allow_dangerous_modes = true` (§ 9) |
| `-32010` | demande inconnue ou déjà close (répondue dans la TUI, fin de tour, session arrêtée…) |
| `-32011` | mauvais genre de demande (répondre à une question avec `answerPermission`, ou l'inverse) |
| `-32012` | aucun relais n'attend la décision : demande sans détails (connue par une notification), délai du relais dépassé, ou relais pas encore rattaché (voir `answerable`) ; répondre dans le terminal |
| `-32013` | « Toujours » impossible : aucune règle proposée par Claude Code (`always_rules` vide) |
| `-32014` | `sessions.setMode` impossible : mode courant inconnu ou hors du cycle de Shift+Tab, ou mode visé hors du cycle |
| `-32015` | `sessions.resume` impossible : Claude Code n'a pas de transcript pour cette session (message : « Claude Code n'a pas de transcript pour cette session : impossible de la reprendre ») |
| `-32016` | `sessions.resume` impossible : le dossier de travail n'existe plus (message : « Le dossier de la session n'existe plus (worktree supprimé ?) : <cwd> ») ; aussi `sessions.diff`, `sessions.diffFile`, `sessions.sendReview`, `forge.sessionCi` |
| `-32017` | dossier hors dépôt git : diff impossible (« la session n'est pas dans un dépôt git »), `sessions.launch` avec `worktree`, `worktrees.list`, `worktrees.remove` (`root` hors dépôt) |
| `-32018` | sous-agent inconnu dans cette session (`sessions.subagent`) |
| `-32019` | `worktrees.remove` refusé : « une session tourne dans ce worktree » (session vivante du démon dont le `cwd` est dans ce worktree) ; aussi `sessions.launch` / `sessions.resume` dans un worktree en cours de suppression (« ce worktree est en cours de suppression ») |
| `-32020` | `worktrees.remove` refusé sans `force` : le worktree a des modifications non commitées ou des fichiers non suivis non ignorés ; `data: {files: [chemins], total}` (au plus 20 chemins, relatifs au worktree) |
| `-32021` | `files.write` refusé : « le fichier a été modifié depuis son ouverture » ; `data: {version}` (version actuelle, `null` si le fichier n'existe plus) ; rien n'est écrit |
| `-32022` | forge indisponible (toutes les méthodes `forge.*` sauf `forge.status`) : accès désactivé, dépôt hors GitHub, `gh` absent ou non connecté ; message « forge indisponible : <raison> », `data: {reason}` (la raison seule, en français) |
| `-32023` | `forge.submitReview` refusé : « la demande de fusion a changé depuis son ouverture » (la tête relue n'est plus `expected_head_sha`) ; `data: {head_sha}` (tête actuelle) ; rien n'est publié |
| `-32024` | `runners.start` : `runner_id` absent de la détection refaite à l'instant par le démon (« runner inconnu : « … » (absent de la détection actuelle) »), ou empreinte différente de `expected_fingerprint` (« la commande a changé depuis sa confirmation », `data: {fingerprint}` : l'empreinte actuelle) ; jamais de commande libre (§ 4, « Runners ») |
| `-32025` | `runners.start` : 8 runners vivants pour cette session (« 8 runners tournent déjà pour cette session : en arrêter un d'abord ») |
| `-32026` | processus de runner inconnu (`process_id`), ou qui n'appartient pas à la session `id` donnée (`runners.stop`, `runners.subscribe`, `runners.resize`) |

Une erreur peut porter un champ `data` (objet) avec des détails structurés, en plus de `code` et `message` ; il n'est présent que là où ce document le décrit (aujourd'hui : commentaires de fichier de `sessions.sendReview`, `{index, path, line, line_end}` ; `-32020` de `worktrees.remove`, `{files, total}` ; `-32021` de `files.write`, `{version}` ; `-32022` des méthodes `forge.*`, `{reason}` ; `-32023` de `forge.submitReview`, `{head_sha}` ; `-32024` de `runners.start` (empreinte changée), `{fingerprint}` ; `-32602` d'un commentaire de `forge.submitReview`, `{index, path, line, side}`). Un client doit ignorer un `data` qu'il ne connaît pas.

## 4. Méthodes

| Méthode | Paramètres | Résultat |
|---|---|---|
| `hello` | `{client?}` | `{server: "orchd", version, protocol: 1, pid, capabilities: {initial_prompt: true, runners: true, send_prompt_paste: true, ci: true, slash_commands: true}}` (`capabilities` : fonctions détectables par le client ; absent d'un démon plus ancien ; l'app les transmet à la page dans l'état de connexion, booléens seulement) |
| `profiles.list` | — | `{profiles: [Profil]}` |
| `projects.resolve` | `{path}` | `{path, exists, inferred, is_git, root, worktree_root, common_dir, branch, name}` (voir ci-dessous) |
| `sessions.list` | — | `{sessions: [Session]}`, de la plus récente à la plus ancienne |
| `sessions.get` | `{id}` | `{session: Session}` |
| `sessions.launch` | `{cwd, profile?, model?, mode?, prompt?, cols?, rows?, worktree?: {branch, base?, location?, path?}, issue?: {number, title, url}, initial?: {instruction, pasted?}}` | `{session: Session, warnings: [texte], worktree?: {path, branch, base}}` (voir « Worktrees ») |
| `sessions.resume` | `{id}` ou `{claude_session_id, cwd?}`, plus `{profile?, mode?, model?, prompt?, cols?, rows?}` | `{session: Session, warnings: [texte]}` |
| `sessions.subscribe` | `{id, history?}` | `{id, snapshot: Écran, history?}` puis le flux (§ 6) |
| `sessions.unsubscribe` | `{id}` | `{unsubscribed: bool}` |
| `sessions.resize` | `{id, cols, rows}` | `{cols, rows}` |
| `sessions.input` | `{id, data}` | `{}` une fois le texte mis en file (texte UTF-8 ; les trames `0x03` sont préférables pour le clavier) |
| `sessions.stop` | `{id, stop_runners?}` | `{stopping: bool, alive: bool, runners_stopping?}` (avec `stop_runners: true`, les runners vivants de la session sont aussi arrêtés ; `runners_stopping` : leur nombre) |
| `sessions.setMode` | `{id, mode}` | `{sent}` : nombre de Shift+Tab envoyés (voir ci-dessous) |
| `sessions.update` | `{id, title?: texte \| null, color?: couleur \| null}` | `{session: Session}` (voir ci-dessous) |
| `sessions.forget` | `{id}` | `{forgotten: true}` (voir ci-dessous) |
| `sessions.answerPermission` | `{id, request_id, decision: "allow" \| "allow_always" \| "deny", message?}` | `{request_id, resolved: true}` |
| `sessions.answerQuestion` | `{id, request_id, answers: {"<texte de la question>": "<libellé>" \| ["<libellé>", …]}}` | `{request_id, resolved: true}` |
| `transcripts.list` | `{profile?, limit?, include_hidden?, exclude_known?}` | `{profile, sessions: [AncienneSession]}` (voir ci-dessous) |
| `transcripts.hide` | `{profile?, claude_session_id}` | `{hidden: true}` |
| `transcripts.unhide` | `{profile?, claude_session_id}` | `{hidden: false}` |
| `quotas.get` | `{refresh?: bool}` | `{profiles: {"<profil>": Quotas}}` (voir ci-dessous) |
| `sessions.diff` | `{id}` | `{base, files}` (voir « Diff et relecture ») |
| `sessions.diffFile` | `{id, path}` | `{hunks, binary, too_large}` |
| `sessions.sendReview` | `{id, comments: [{path, line, side, text}], general?}` | `{sent: true}` |
| `sessions.commits` | `{id, limit?, range?}` | `{range, stats, base, head, commits, truncated}` (voir « Historique des commits ») |
| `sessions.commitDiff` | `{id, sha}` | `{sha, base, files, truncated, skipped_non_utf8}` |
| `sessions.commitDiffFile` | `{id, sha, path}` | `{hunks, binary, too_large}` |
| `files.list` | `{id, path?}` | `{root, path, entries, truncated}` (voir « Fichiers d'une session ») |
| `files.read` | `{id, path}` | `{path, size, binary, too_large, content, version, editable, not_editable_reason}` |
| `files.write` | `{id, path, content, expected: {sha256} \| null}` | `{version}` (voir « Fichiers d'une session ») |
| `sessions.subagents` | `{id}` | `{agents: [Sous-agent]}`, ordre de lancement, **sans** `report` (voir « Sous-agents ») |
| `sessions.subagent` | `{id, agent_id}` | `Sous-agent` **avec** `report` |
| `conversation.get` | `{id, before?, limit?}` | `{segments, entries: [Entrée], has_more, invalid_lines}` (voir « Vue conversation ») |
| `conversation.subagent` | `{id, agent_id, before?, limit?}` | même forme, pour le fichier d'un sous-agent |
| `conversation.full` | `{id, uid, part: "input" \| "result" \| "text"}` | `{text, truncated}` (4 Mio au plus) |
| `sessions.sendPrompt` | `{id, text}` ou `{id, instruction, pasted?}` | `{sent: true}` (voir « Vue conversation » ; en deux temps : « Livraison et suivi de CI ») |
| `commands.list` | `{id}` | `{commands: [Commande], claude_code_version, truncated, ignored}` (voir « Slash commands ») |
| `worktrees.list` | `{root}` | `{root, common_dir, default_branch, reference, worktrees: [Worktree]}` (voir « Worktrees ») |
| `worktrees.remove` | `{root, path, delete_branch?, force?}` | `{removed: true, path, branch, branch_deleted, branch_error}` |
| `forge.status` | `{root, enabled?, refresh?}` | `{available, kind, host, repo, reason, capabilities}` (voir « Forge ») |
| `forge.issues` | `{root, enabled?, refresh?, state?, search?, assignee?, label?, labels?, limit?}` | `{issues: [Issue sans corps], truncated}` |
| `forge.labels` | `{root, enabled?, refresh?}` | `{labels: [{name, color, description}]}` |
| `forge.issue` | `{root, number, enabled?, refresh?}` | `Issue` complète, sous-issues comprises |
| `forge.pulls` | `{root, enabled?, refresh?, state?, search?, author?, limit?}` | `{pulls: [Pull sans corps], truncated}` (voir « Forge : demandes de fusion ») |
| `forge.pull` | `{root, number, enabled?, refresh?}` | `Pull` complète : corps, `files`, `check_runs`, `review_threads` |
| `forge.pullFile` | `{root, number, path, enabled?, refresh?}` | `{hunks, binary, too_large}` |
| `forge.pullForBranch` | `{root, branch, enabled?, refresh?}` | `Pull` sans corps, ou `null` |
| `forge.submitReview` | `{root, number, expected_head_sha, event, body?, comments?, enabled?}` | `{url}` — **écriture** vers la forge, socket de contrôle seulement |
| `forge.runs` | `{root, branch?, sha?, limit?, enabled?, refresh?}` | `{runs: [Run], truncated}` (voir « Livraison et suivi de CI ») |
| `forge.runFailure` | `{root, run_id, enabled?, refresh?}` | `{run, failed_jobs, logs, truncated, in_progress, instruction, excerpt}` |
| `forge.sessionCi` | `{id, mode?, enabled?, refresh?}` | `{mode, delivery, pull, base_branch, ci}` ; démarre le suivi de la CI de la session |
| `forge.configure` | `{enabled}` | `{}` : réglage « Accès aux forges » de l'app (processus principal, à la connexion et à chaque changement) ; `false` arrête le sondage de la CI et vide son suivi |
| `runners.list` | `{id}` | `{runners: [Runner], running: [RunnerProcess]}` (voir « Runners ») |
| `runners.start` | `{id, runner_id, expected_fingerprint, cols?, rows?}` | `RunnerProcess` + `warnings: [texte]` |
| `runners.stop` | `{id?, process_id}` | `{stopping: bool, alive: bool}` |
| `runners.subscribe` | `{id?, process_id, history?, cols?, rows?}` | `{process_id, snapshot: Écran, history?}` puis le flux (§ 6) |
| `runners.unsubscribe` | `{process_id}` | `{unsubscribed: bool}` |
| `runners.resize` | `{id?, process_id, cols, rows}` | `{cols, rows}` |

Détails :

- **`cwd`** : chemin absolu d'un dossier existant (résolu, liens suivis). **`profile`** : nom d'un profil de `profiles.list` (`default` par défaut). **`mode`** : `default` (ou `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` ; absent = le mode par défaut de Claude Code pour ce profil (aucun `--permission-mode` passé). **`cols`/`rows`** : 1 à 1000 (80×24 par défaut au lancement, taille courante à la reprise).
- **`projects.resolve`** passe par la CLI `git` : `root` est le worktree principal (parent du dossier commun quand il s'appelle `.git`), `worktree_root` la racine du worktree contenant `path`, `common_dir` le dossier commun (identifiant du projet), `branch` absente en HEAD détachée ou avant le premier commit. Hors dépôt (ou sans `git`) : `is_git: false`, `root` = `path`, le reste `null`. Dossier existant : `exists: true, inferred: false`.
  - **Dossier disparu** (worktree supprimé ; `path` absolu, sinon `-32602`) : `exists: false`, rien n'est créé. Le projet **enregistré** passe d'abord (v0.2, lot 6) : celui d'une session du démon dont le `cwd` contient `path` (le plus profond ; `Session.project_common_dir` connu), sinon celui d'un worktree créé par le démon qui contient `path` (table `worktrees`, § 9) ; `inferred: true`, `root` = `project_root` de la session (ou du worktree), `common_dir` enregistré. Une session dont le worktree a été supprimé reste ainsi sous son projet quel que soit l'emplacement (`sibling` n'est pas reconnu par la déduction). À défaut, le projet est deviné :
    1. un voisin : si le premier composant manquant s'appelle `<nom>--<suffixe>` ou `<nom>.<suffixe>`, le dossier `<parent>/<nom>` s'il est la racine d'un dépôt git (préfixe le plus long d'abord) ;
    2. sinon le dépôt qui contient le plus proche ancêtre existant, **seulement** si le chemin est rangé comme un worktree de ce dépôt : sous `<racine>/.worktrees/`, sous `<racine>/.claude/worktrees/`, ou directement sous `<racine>` (premier composant manquant enfant de la racine). Un dépôt lointain (par exemple un dépôt de fichiers de configuration dans `~` pour `~/a/b/c`) n'est pas retenu.

    Lu par `git` et sur le disque, hors du runtime du démon.

    Trouvé : `{"path": "<path>", "exists": false, "inferred": true, "is_git": true, "root": "<racine du dépôt>", "worktree_root": null, "common_dir": "…", "branch": null, "name": "<nom du dépôt>"}`. Sinon : `{"path": "<path>", "exists": false, "inferred": false, "is_git": false, "root": null, "worktree_root": null, "common_dir": null, "branch": null, "name": "<dernier composant>"}`.
- **`sessions.launch`** choisit un UUID qui sert à la fois d'identifiant interne (`id`) et de `--session-id` pour Claude Code (`claude_session_id`). Le second change ensuite sur `/clear` ; seul `id` est stable.
- **`sessions.resume`** :
  - tous les paramètres (profil, mode, taille, dossier, binaire `claude`) sont vérifiés avant de toucher à la session ; si la reprise échoue (y compris au lancement du processus), `sessions.list` est inchangé et l'écran n'est pas effacé ;
  - avec `id` : la session du démon, qui ne doit pas tourner (`-32002` sinon), est relancée avec `--resume <claude_session_id>`. Si son processus vient de se terminer mais que le démon ne l'a pas encore constaté (délai de grâce de 0,5 s laissé à un `SessionEnd` en retard), la fin est constatée sur-le-champ et la reprise a lieu. La session garde son `id`, son terminal et ses abonnés (le démon envoie `ESC[0m CRLF ESC[2J ESC[H` dans le flux juste avant la première sortie du nouveau processus) ;
  - avec `claude_session_id` seul : si une session arrêtée du démon porte ce `claude_session_id`, c'est elle qui est reprise ; sinon (ancienne session trouvée par `transcripts.list`) une nouvelle entrée est créée, dans `cwd` s'il est donné, sinon dans le dossier de reprise lu dans le transcript (le `cwd` de `transcripts.list`, voir « Dossier de reprise » ; `-32602` « « cwd » manquant pour une ancienne session » si le transcript n'en porte aucun). Elle reprend le nom de la conversation : `first_prompt` et titre de Claude Code (`aiTitle`/`summary`, dans `metrics.session_name`) lus dans le transcript du profil, et `title`/`color` d'une autre entrée du démon pour le même `claude_session_id` s'il y en a ;
  - les paramètres absents reprennent ceux de la session (profil, mode, modèle, taille). Pour le dossier, une exception : si Claude Code ne retrouverait pas la conversation depuis le `cwd` de la session (il a changé, ou une reprise précédente a été forcée ailleurs) et que le transcript désigne un dossier de reprise, c'est celui-ci qui est pris (et devient le `cwd` de la session).
- **Dossier de reprise** : Claude Code range une conversation sous `<dossier du profil>/projects/<cwd encodé>/` et, avec `--resume <id>`, ne la cherche **que** dans le dossier de projet de son propre dossier de travail. Encodage (Claude Code 2.1.306) : chaque unité UTF-16 du chemin qui n'est pas une lettre ou un chiffre ASCII devient `-` (`/`, `.`, `_`, `-`, espace, `é` ; un caractère hors du plan de base, comme un émoji, donne deux `-`) ; au-delà de 200 unités, les 200 premières suivies de `-` et de la valeur absolue, en base 36, de l'empreinte `h = h·31 + unité` (entier signé de 32 bits) du chemin d'origine. Exemple : `/home/u/workplace/next-level.run` → `-home-u-workplace-next-level-run`. L'encodage perd de l'information : le nom du dossier n'est jamais décodé, le démon cherche parmi les `cwd` enregistrés dans le transcript (dans l'ordre du fichier) le premier dont l'encodage est ce nom et qui existe. Les lignes d'un transcript peuvent porter plusieurs `cwd` (`cd` pendant la session, conversation reprise depuis un autre dossier…), le premier ou le plus fréquent n'est pas forcément le bon. Un gros transcript lu par le début et la fin est relu en entier (seulement les `"cwd":"…"`) si aucun de ceux-là ne convient.
- **Avertissement de dossier** : `sessions.resume` (par `id` ou par `claude_session_id`) vérifie que `<dossier du profil>/projects/<encodage du dossier retenu>/<claude_session_id>.jsonl` existe. Sinon la reprise a lieu quand même (choix de l'appelant), mais `warnings` contient « Claude Code ne trouvera pas la conversation depuis ce dossier (<dossier>) : elle a été enregistrée depuis un autre dossier » (aussi au journal). Cas : `cwd` passé en paramètre incompatible, ou ancienne session sans dossier de reprise retrouvé (`resume_cwd_inferred: false`).
- **Reprise refusée par Claude Code** : si le processus d'une reprise sort avec un code non nul avant tout `SessionStart` et que l'écran affiche « No conversation found » (« No conversation found with session ID: <id> », code 1), la session passe en erreur avec une raison lisible : `status: {"state": "error", "reason": "conversation_not_found", "message": "Claude Code n'a pas trouvé la conversation <id> depuis le dossier <cwd> (« No conversation found ») : il ne la cherche que parmi celles enregistrées depuis ce dossier"}`, précédé de l'effet `resume_failed` (§ 5) et journalisé. Raison et message sont effacés au lancement suivant (et ne survivent pas à un redémarrage du démon) ; la session reste reprenable (sans `cwd`, la reprise suivante revient au dossier de reprise).
- **Transcript requis pour reprendre** : `sessions.resume` (par `id` ou par `claude_session_id`) vérifie, avant de toucher à quoi que ce soit, que Claude Code a un transcript pour la conversation à reprendre (`<dossier du profil retenu>/projects/<un dossier>/<claude_session_id>.jsonl`, recherche par nom de fichier). Sinon `-32015` : `--resume` échouerait (cas des sessions lancées avec un marqueur `CLAUDE_CODE_CHILD_SESSION` hérité, § 8, dont Claude Code n'a rien enregistré). La session reste telle quelle ; elle peut être oubliée (`sessions.forget`).
- **`Session.resumable`** : `true` si la session ne tourne pas, qu'un transcript existe pour son `claude_session_id` dans le dossier de son profil (même recherche) **et** que son `cwd` existe ; `false` sinon, toujours `false` pour une session vivante. **`Session.resume_blocker`** dit pourquoi : `null` (vivante ou reprenable), `"transcript_missing"` (prioritaire : définitif) ou `"cwd_missing"` (dossier disparu, worktree supprimé ; plus tard l'app proposera de le recréer). `sessions.resume` vérifie, avant tout et dans le même ordre, le transcript (`-32015`) puis le dossier (`-32016`, y compris pour un `cwd` absolu passé en paramètre qui n'existe pas, et pour une ancienne session reprise par `claude_session_id` + `cwd`). Recalculé à la fin du processus, à la relecture de la base au démarrage, à chaque `sessions.list` et à chaque `sessions.get` (un transcript supprimé ou apparu depuis est alors pris en compte ; `session.updated` si la valeur change). La recherche se fait sur la liste des transcripts du profil (noms des fichiers `projects/*/*.jsonl`), gardée en cache tant que ni `projects/` ni aucun de ses sous-dossiers n'a changé de date de modification, et 2 s au plus ; jamais sous le verrou du registre.
- **`sessions.forget {id}`** (« Retirer de la liste ») : retire une session qui ne tourne pas (arrêtée ou en erreur) du démon et de la base, **et masque** son transcript (`profile`, `claude_session_id` courant) de `transcripts.list`, durablement (voir `transcripts.hide`). Un processus qui vient de se terminer mais dont le démon n'a pas encore constaté la fin (délai de grâce de 0,5 s) est d'abord constaté terminé, puis la session est oubliée. `-32002` si elle tourne (l'arrêter d'abord), `-32001` si elle est inconnue (dont déjà oubliée), `-32602` sans `id`. Diffuse `session.removed {id}` à tous les clients (§ 5). Si l'écriture en base échoue, l'erreur est journalisée et la réponse reste `{forgotten: true}` (la session reviendrait au prochain démarrage). Les transcripts de Claude Code ne sont **jamais** supprimés (`transcripts.unhide` les fait réapparaître). Un processus d'avant un plantage du démon encore vivant reste refusé au socket de contrôle (§ 10) jusqu'à sa fin.
- **`transcripts.list {profile?, limit?, include_hidden?, exclude_known?}`** :
  - `profile` : `default` par défaut (`-32003` s'il est inconnu) ; `limit` : entier positif, 50 par défaut ;
  - `include_hidden` (booléen, `false` par défaut) : inclure les transcripts masqués ; chaque entrée porte `hidden: true | false` ;
  - `exclude_known` (booléen, `true` par défaut) : écarter les conversations que le démon connaît déjà (une session de `sessions.list` a ce `claude_session_id`) ;
  - `limit` s'applique **après** ces exclusions : jusqu'à `limit` entrées utiles. Un booléen d'un autre type : `-32602`.
- **`transcripts.hide {profile?, claude_session_id}`** → `{hidden: true}` : masque une ancienne session (connue seulement par son transcript) de `transcripts.list`, durablement (table `hidden_transcripts`, § 9) ; déjà masquée : sans effet. **`transcripts.unhide`** → `{hidden: false}` : la fait réapparaître (rien à faire si elle n'était pas masquée). `claude_session_id` manquant ou vide : `-32602` ; profil inconnu : `-32003`. Aucun fichier n'est jamais supprimé ; une session du démon n'est pas concernée (elle reste dans `sessions.list` jusqu'à `sessions.forget`).
- **`sessions.stop`** envoie `SIGHUP` au groupe de processus de `claude`, puis `SIGKILL` au bout de 3 s s'il tourne encore. La réponse arrive tout de suite ; la fin est annoncée par `session.updated` (`alive: false`).
- **`sessions.launch`, `sessions.resume`, `sessions.setMode`** refusent `bypassPermissions` et `dontAsk` (`-32005`, message en français) sauf si `allow_dangerous_modes = true` (§ 9). À la reprise, le mode retenu est vérifié même s'il n'est pas demandé : une session qui était en `bypassPermissions` n'est reprise ainsi qu'avec le réglage (sinon, passer un autre `mode`).
- **Mode par défaut rendu explicite** : sans `mode` (et, à la reprise, sans mode connu de la session), le démon lit `permissions.defaultMode` (lecture seule) dans `<cwd>/.claude/settings.local.json`, sinon `<cwd>/.claude/settings.json`, sinon `<dossier du profil>/settings.json`. Mode trouvé et sûr : passé tel quel par `--permission-mode`. Mode dangereux sans `allow_dangerous_modes` : la session est lancée en `--permission-mode manual` et `warnings` contient un message en français (aussi au journal). Rien de trouvé : pas de `--permission-mode`. `warnings` est vide sinon.
- **`Session.scope`** : unité du scope systemd de la session (`devmaestro-session-<8>-<8>.scope`), ou `null` si elle a été lancée directement (§ 9).
- **`sessions.update`** : nom et couleur choisis par l'utilisateur, pour toute session du démon (qui tourne ou non).
  - Clé absente : inchangée ; `null` : effacée. Au moins une des deux clés est attendue (`-32602` « rien à modifier » sinon).
  - `title` : texte, blancs de début et de fin retirés, **80 caractères** (points de code) au plus, sans caractère de contrôle (saut de ligne, tabulation…), sans caractère invisible de mise en forme (catégorie Unicode Cf : forçage du sens d'écriture U+202A–U+202E et U+2066–U+2069, espaces sans chasse U+200B/U+200C/U+FEFF…, et séparateurs U+2028/U+2029) ; seul l'antiliant U+200D, qui compose les émojis, est admis. Un titre sans aucun caractère visible après nettoyage vaut `null`.
  - `color` : un nom de la palette `"gris" | "bleu" | "vert" | "jaune" | "orange" | "rouge" | "violet" | "rose"` (l'app choisit le rendu de chaque jeton).
  - Erreurs : `-32602` (paramètre invalide, rien ne change), `-32001` (session inconnue).
  - Effet : enregistré en base, `session.updated` diffusé, `updated_at` **inchangé** (renommer ne fait pas remonter la session dans `sessions.list`). Titre et couleur suivent la session à la reprise (`sessions.resume`, même entrée) et au redémarrage du démon.
  - Exemple : `{"id": "…", "title": "Refonte du relais", "color": "violet"}` → `{"session": {…, "title": "Refonte du relais", "color": "violet", "display_name": "Refonte du relais", …}}`.
- **`Session.display_name`** (toujours un texte), calculé par le démon : `title` s'il y en a un, sinon le `session_name` de la statusline (`metrics.session_name`), sinon `first_prompt`, sinon les 8 premiers caractères de `id`. Le nom de Claude Code et le prompt sont ramenés à une ligne (blancs réduits à une espace) et coupés à 60 caractères (suivis de `…`).
- **`Session.first_prompt`** : premier prompt tapé, tel que reçu par `UserPromptSubmit` (ou le `prompt` de `sessions.launch`, retenu dès le lancement), coupé à 200 caractères (`…`). Les textes qui commencent par `/` (commandes) et les textes vides ne comptent pas. Il n'est pas remis à zéro par `/clear`.
- **`transcripts.list`** : `cwd` est le dossier de reprise (voir « Dossier de reprise »), celui que `sessions.resume` prend par défaut, et `cwd_exists` porte sur lui ; `resume_cwd_inferred: false` quand aucun `cwd` du transcript ne correspond au dossier qui le contient (encodage ambigu, dossier disparu) : `cwd` est alors le premier `cwd` lu, comme avant, et une reprise depuis lui donnera l'avertissement de dossier. Chaque ancienne session porte aussi `display_name` (toujours un texte) : le `title` d'une session du démon qui a le même `claude_session_id`, sinon le titre donné par Claude Code (`title` : `aiTitle` ou `summary` du transcript), sinon `first_prompt`, sinon les 8 premiers caractères de `claude_session_id` (mêmes règles de mise sur une ligne et de coupe à 60 caractères).

### Répondre depuis l'app (ADR 0003)

La TUI affiche sa propre demande pendant que le relais `PermissionRequest` attend : l'app et le terminal sont **deux canaux concurrents, la première réponse gagne**. Une réponse de l'app ferme le dialogue de la TUI (constaté au prototype n° 1).

- Une demande n'est répondable depuis l'app que si `answerable` vaut `true` dans `session.updated` (un relais attend sa décision). Pour une question, la carte apparaît dès le `PreToolUse` (`answerable: false`) et devient répondable quand le `PermissionRequest` arrive (environ 0,3 s plus tard) ; répondre avant renvoie `-32012`.
- **`sessions.answerPermission`** :
  - `allow` → `{"behavior": "allow"}` (sans `updatedInput` : il remplacerait toute l'entrée de l'outil) ;
  - `allow_always` → `{"behavior": "allow", "updatedPermissions": always_rules}` : les règles reprises des `permission_suggestions` de la demande (voir `always_rules` dans Demande, § 7). C'est Claude Code qui les écrit ; DevMaestro n'écrit jamais dans `~/.claude*` ni dans la configuration du projet. Sans règle : `-32013` « aucune règle proposée par Claude Code pour « Toujours » » ;
  - `deny` → `{"behavior": "deny", "message": message}` (`message` omis s'il est vide).
- **`sessions.answerQuestion`** : `allow` avec `updatedInput` = `tool_input` d'origine + `answers`. Chaque question de la demande doit recevoir une réponse : un libellé d'option, un texte libre, ou pour une question `multi_select` une liste de libellés, joints par `", "` (la documentation dit « joints par des virgules » ; séparateur exact **non vérifié** avec le vrai CLI). Clé inconnue, réponse manquante ou vide, liste de plusieurs libellés pour une question simple : `-32602`.
- Erreurs communes : `-32001` session inconnue, `-32010` demande inconnue ou déjà close, `-32011` mauvais genre, `-32012` pas de relais. En cas d'erreur, rien ne change.
- **`resolved: true`** veut dire : la décision a été **remise au relais qui attendait** (et la demande close dans le démon). Pas que Claude Code l'a appliquée : si la TUI a répondu au même moment, Claude Code garde la première réponse et ignore l'autre (constaté au prototype n° 1). La session dira ensuite ce qui s'est passé (`PostToolUse`, `Stop`…).
- Une réponse acceptée clôt aussitôt la demande dans le démon : effet `request_resolved` avec `how: "answered_by_app"`, puis `session.updated` (la session repasse `running`). Le `PostToolUse` qui suit ne trouve plus rien à clore : une seule clôture par demande.
- La réponse est remise aux relais (plusieurs si Claude Code a relancé le même hook : déduplication). Si la TUI a répondu entre-temps, Claude Code ignore la décision (constaté).

### Diff et relecture (v0.2, lot 1)

Le démon calcule le diff du worktree de la session par la CLI `git` (arguments séparés, jamais de shell ; depuis la racine du worktree, donc aussi dans un worktree lié ; `--literal-pathspecs` : un nom de fichier n'est jamais un motif ; chaque commande est tuée au bout de 10 s ; hors du runtime du démon). Configuration imposée à chaque appel : `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.relative=false -c diff.submodule=short -c core.quotePath=false -c diff.external= -c core.pager=cat`, `--no-pager`, `--no-ext-diff --no-textconv` pour les diffs, références par leur nom complet (`refs/remotes/…`, `refs/heads/…`) ; environnement `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0` (l'index n'est jamais écrit), `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. **Risque résiduel** : comparer à l'arbre de travail peut lancer les filtres `filter.<pilote>.clean` du dépôt (`.gitattributes` et configuration du dépôt, comme Git LFS) ; ils ne se coupent pas de façon générique : un dépôt non fiable peut exécuter du code à chaque calcul, comme avec un `git status` de l'utilisateur. Session hors dépôt : `-32017` ; dossier disparu : `-32016` ; session inconnue : `-32001` ; échec de `git` : `-32603`. Une session arrêtée garde un diff lisible.

**`sessions.diff {id}`** :

```json
{"base": {"ref": "origin/main", "sha": "…", "kind": "merge_base"},
 "files": [
   {"path": "src/a.rs", "status": "M", "additions": 3, "deletions": 1, "binary": false},
   {"path": "src/neuf.rs", "old_path": "src/vieux.rs", "status": "R", "additions": 2, "deletions": 2, "binary": false},
   {"path": "logo.png", "status": "?", "additions": 0, "deletions": 0, "binary": true},
   {"path": "build/vieux.log", "status": "?", "additions": null, "deletions": 0, "binary": false}
 ],
 "truncated": false, "skipped_non_utf8": 0}
```

- **Base** : `git merge-base HEAD <branche par défaut>`, la branche par défaut étant `origin/HEAD` (`ref` : `origin/main`…), sinon `main`, sinon `master` (`kind: "merge_base"`) ; à défaut (pas de branche par défaut, pas d'ancêtre commun) `HEAD` (`kind: "head"`, `ref: "HEAD"`) ; dépôt sans commit : l'arbre vide (`kind: "head"`).
- **Fichiers** : la base comparée à l'arbre de travail (`git diff -M --name-status -z` et `--numstat -z` : commits depuis la base, index et modifications non indexées), plus les fichiers non suivis (`git ls-files --others --exclude-standard`, 2 000 au plus). Chemins relatifs à la racine du worktree, triés. `status` : `A` ajouté, `M` modifié (changement de type compris), `D` supprimé, `R` renommé (avec `old_path`, détection de git par similarité), `?` non suivi (une copie compte comme un ajout). `additions` / `deletions` : lignes (0 pour un binaire). Pour un non suivi, `additions` compte ses lignes pour les **200 plus récents** (date de modification ; résultat gardé en cache tant que taille et date ne changent pas) et vaut `null` pour les autres et au-delà de 1 Mio (rien n'est lu). `binary` : selon git (`-` dans `numstat`), ou un octet nul dans les 8 000 premiers octets pour un non suivi compté (`false` s'il n'est pas lu).
- `truncated: true` : liste incomplète (plus de 2 000 non suivis, ou sortie de `git` au-delà de 32 Mio). `skipped_non_utf8` : fichiers écartés parce que leur chemin n'est pas de l'UTF-8 (jamais montrés sous un chemin déformé).

**`sessions.diffFile {id, path}`** : `path` doit être un `path` de la liste de la session (la dernière calculée si elle a moins de **2 s**, sinon recalculée ; sinon `-32602`) : aucune lecture d'un autre fichier. `sessions.diff` recalcule toujours.

```json
{"hunks": [{"header": "@@ -1,3 +1,4 @@ fn x()", "old_start": 1, "old_lines": 3, "new_start": 1, "new_lines": 4,
            "lines": [{"kind": " ", "old_no": 1, "new_no": 1, "text": "un"},
                      {"kind": "-", "old_no": 2, "new_no": null, "text": "deux"},
                      {"kind": "+", "old_no": null, "new_no": 2, "text": "DEUX"}]}],
 "binary": false, "too_large": false}
```

- Diff unifié avec 3 lignes de contexte (`git diff -M -U3 <base> -- [<ancien>] <chemin>`) ; un non suivi est montré entièrement ajouté (`@@ -0,0 +1,n @@`). `text` sans le `\n` final (ni `\r`) ; « \ No newline at end of file » est omis.
- `binary: true` (aucun bloc) pour un fichier binaire ; `too_large: true` (aucun bloc) si un des deux côtés dépasse **1 Mio** ou si le diff dépasse **20 000 lignes**.

**`session.diff_changed {id}`** : le démon recalcule le diff d'une session après chaque `PostToolUse`, `PostToolUseFailure`, `Stop` et `StopFailure`, et toutes les **5 s** pendant qu'elle tourne (rien pour une session arrêtée), avec un anti-rebond de **500 ms** (un seul recalcul en attente par session). Pendant un recalcul en cours, un tic du sondage est sauté et un hook en fait refaire un juste après : jamais d'empilement. Il compare une empreinte (base, `HEAD`, chemins, statuts, compteurs, et taille et date de modification en ns de chaque fichier : un contenu qui change à compteurs égaux est vu) à la dernière **notifiée** pour la session, et n'envoie la notification, à tous les clients, que si elle a changé. `sessions.diff` ne remplace pas cette référence (sauf pour poser la première) : chaque client est prévenu, quel que soit qui a lu le diff. Le premier calcul ne notifie pas. Un client en retard (resynchronisation) reçoit un `session.diff_changed` par session.

**`sessions.sendReview {id, comments: [{kind?: "diff", path, line, side: "new" | "old", text} | {kind: "file", path, line, line_end, text?} | {kind: "commit", sha, path, line, side, text}], general?}`** → `{sent: true}` :

Trois sortes de commentaires, mélangeables dans une même revue : de **diff** (`kind` absent ou `"diff"`, onglet Diff), de **fichier** (`kind: "file"`, sélection de lignes dans l'onglet Fichiers, v0.2 lot 3 bis) et de **commit** (`kind: "commit"`, diff d'un commit de l'onglet Commits, v0.3 lot 9 : voir « Historique des commits »). Tout autre `kind` : `-32602`.

- Validation (`-32602`, rien n'est envoyé) : au plus **200** commentaires (toutes sortes confondues) ; pour un commentaire de diff : `path` dans la liste de `sessions.diff` ; `line` entier ≥ 1 (numéro dans la nouvelle version pour `side: "new"`, dans l'ancienne pour `"old"`) ; `text` non vide ; pour un commentaire de fichier : voir ci-dessous ; `text` et `general` d'au plus **4 000** caractères ; au moins un commentaire ou un `general` non vide. Les erreurs sur les champs d'un commentaire de diff sont préfixées de son rang (« commentaire 2 : … ») ; « ne fait pas partie du diff » nomme le chemin. **Toute** erreur liée à un commentaire de fichier (champs, chemin refusé ou introuvable, fichier binaire ou trop gros, lignes hors du fichier) nomme son rang, le chemin et les lignes demandés (« commentaire 2 (« src/a.rs », lignes 3-4) : hors du fichier (3 ligne(s)) ») et porte `data: {index, path, line, line_end}` (§ 3 ; `index` à partir de 0 dans `comments`, valeurs telles que reçues, `line_end` = `line` s'il est absent) pour que le front désigne l'extrait fautif. Texte collé au plus **256 Kio** (octets UTF-8, titre et remarque générale compris) : au-delà, `-32602` « revue trop volumineuse : n Kio sur 256 Kio au plus », sans `data`. La session doit tourner (`-32002` « la session ne tourne pas… » sinon) et n'avoir **aucune demande en attente** (statut `waiting`, permission ou question : `-32002` « une demande attend une réponse dans la session », l'Entrée validerait le dialogue de la TUI). Chemins des commentaires de diff validés sur la liste de la session (moins de 2 s, comme `sessions.diffFile`) ; le diff n'est calculé que s'il y a au moins un commentaire de diff (une revue faite seulement de commentaires de fichier marche aussi hors dépôt, sans `-32017`).
- **Commentaire de fichier** `{kind: "file", path, line, line_end, text?}` : `path` relatif à la racine de la session, normalisé et refusé comme pour `files.read` (absolu, `..`, `.git`, octet nul, vide) ; `line` entier ≥ 1, `line_end` entier ≥ `line` (absent : `line`), au plus **400** lignes ; `text` facultatif (absent ou vide : pas de paragraphe de commentaire), 4 000 caractères au plus. Le démon **relit lui-même** les lignes, par le même chemin sûr que `files.read` (`openat2` sous la racine, liens suivis seulement s'ils y restent, fichier ordinaire, jamais `.git`) : fichier introuvable, hors racine, pas ordinaire, au-delà de **2 Mio** ou binaire (octet nul dans les 8 000 premiers octets) : `-32602`. Le texte est lu en UTF-8 (octets invalides remplacés par « � », comme `files.read`). Lignes comptées comme dans le diff (un saut de ligne final ne crée pas de ligne vide, `\r` final retiré) ; `line_end` au-delà de la fin du fichier : `-32602` ; fichier vide : 0 ligne. Un fichier aux fins de ligne `\r` isolées (ancien Mac) n'a qu'une ligne pour le démon : ses numéros peuvent différer de ceux du Markdown rendu par le front. Fichier modifié depuis sa lecture par le front : ce sont les lignes **actuelles** qui partent. Aucun texte d'extrait venu du client n'est jamais lu (un champ en trop est ignoré). Un fichier n'est relu que si le commentaire précédent portait sur un autre fichier (un seul fichier en mémoire à la fois). Chaque ligne d'extrait collée est coupée à **2 000** caractères (après nettoyage), suivie de « … » ; cela vaut aussi pour les extraits du diff.
- Envoi (architecture § 9, prototype n° 1 Q8 : la consigne est tapée, seul le contenu est collé) : la consigne tapée, « Voici ma revue de tes changements, applique-la puis dis-moi ce que tu as fait : » s'il y a au moins un commentaire de diff ou de commit (ou seulement `general`), sinon « Voici des extraits de fichiers avec mes remarques, tiens-en compte puis dis-moi ce que tu as fait : », puis la revue collée en *bracketed paste* (`ESC[200~ … ESC[201~`), puis Entrée (80 ms entre les trois). Le verrou des écritures de la session est tenu pendant les trois envois : une autre revue, des Shift+Tab (`sessions.setMode`) ou une entrée passée par le démon (trames `0x03`, `sessions.input`) attendent derrière et ne s'intercalent jamais ; des touches tapées par l'utilisateur dans ces 160 ms attendent aussi, puis suivent la revue. Une fois le verrou pris et juste avant d'écrire, le démon **revérifie** l'état de la session (toujours le même processus en vie, aucune demande en attente) : une permission ou une question apparue pendant la préparation (lecture du disque, `git`) fait refuser la revue avec la même erreur `-32002`, sans rien écrire. L'état est revérifié **une dernière fois juste avant l'Entrée** : une demande apparue pendant l'envoi fait abandonner sans Entrée (`-32002` ; consigne et revue restent dans le champ de la TUI) ; reste le risque d'une demande ouverte dans les quelques millisecondes qui séparent cette vérification de la lecture de l'Entrée. Si Claude travaille, Claude Code met le message en file d'attente.
- Revue (Markdown, en français) :

  ````markdown
  # Revue de code

  <general>

  ### src/a.rs:42
  ```diff
        40 | ligne avant
  +     42 | ligne commentée
  ```

  <commentaire>

  ### src/a.rs:12 (ancienne version)
  …

  ### src/b.rs:10-11
  ```rust
      10 | fn deux() {}
      11 | fn trois() {}
  ```

  <commentaire>
  ````

  Les commentaires suivent l'ordre reçu. Pour un commentaire de diff : `### <chemin>:<ligne>` (« (ancienne version) » pour `side: "old"`), l'extrait du diff (± 2 lignes autour de la ligne, dans son bloc ; absent si la ligne n'est pas dans le diff), puis le commentaire. Pour un commentaire de fichier : `### <chemin>:<début>-<fin>` (`:<ligne>` pour une seule ligne, `<chemin>` normalisé tel que demandé ; dans tout en-tête `###`, un saut de ligne ou une tabulation du chemin devient « ␤ » ou « ␉ » : un nom de fichier ne peut pas injecter de Markdown), les lignes numérotées dans un bloc de code étiqueté par le langage de l'extension (`rs` → `rust`, `ts`/`tsx` → `typescript`, `js`/`jsx`/`mjs` → `javascript`, `json`, `toml`, `yaml`/`yml` → `yaml`, `sh`/`bash` → `bash`, `py` → `python`, `go`, `sql`, `css`, `html`, `md` → `markdown`, sans casse ; sinon pas d'étiquette), puis le commentaire s'il n'est pas vide. Le titre reste « # Revue de code » dans les deux cas. La clôture du bloc de code est plus longue que toute suite de « ` » de l'extrait. Tous les caractères de contrôle sauf saut de ligne et tabulation sont retirés de ce qui est collé (commentaires, chemins, extraits) : rien ne peut sortir du collage encadré ni taper de touche.

### Historique des commits (v0.3, lot 9)

Mêmes garde-fous que le diff (§ « Diff et relecture ») : CLI `git` durcie, configuration imposée, pas de pager ni de diff externe (`--no-ext-diff --no-textconv`), délai de 10 s par commande, sortie lue au plus 32 Mio, hors du runtime. En plus pour `git log` : `--no-color --encoding=UTF-8 --no-show-signature --no-notes`, un `--format` explicite (la configuration `format.pretty`, `log.showSignature`, `log.showRoot`, `log.diffMerges`, `i18n.logOutputEncoding`, `color.ui` du dépôt est sans effet). Session hors dépôt : `-32017` ; dossier disparu : `-32016` ; session inconnue : `-32001` ; échec de `git` : `-32603`. Une session arrêtée garde un historique lisible.

**`sessions.commits {id, limit?, range?: "branch" | "recent"}`** :

```json
{"range": "branch", "stats": true,
 "base": {"ref": "main", "sha": "…", "kind": "merge_base"},
 "head": "…",
 "commits": [
   {"sha": "b7c8b2317a1d853986572cb527064543b83aeb6c", "parents": ["…", "…"], "author": "Élodie",
    "date": "2026-10-20T15:15:38+02:00", "subject": "Merge branch 'f'", "body": "",
    "files": 2, "additions": 1, "deletions": 1}
 ],
 "truncated": false}
```

- **Plage** (`range`, toujours rendu) : du plus récent au plus ancien (ordre de `git log`), `base` et `HEAD` étant ceux de `sessions.diff` (même résolution : `git merge-base HEAD <branche par défaut>`, sinon `HEAD`).
  - `"branch"` : `<base>..HEAD`, les commits de la branche de la session. Les commits d'une branche fusionnée dans la plage en font partie (pas de `--first-parent`), y compris la racine d'un historique sans lien fusionné.
  - `"recent"` : les `limit` derniers commits de `HEAD` (`git log HEAD`, sans exclusion), même format et mêmes compteurs. Pour le travail direct sur la branche par défaut (trunk-based) : une fois tout poussé, la plage de la branche est vide.
  - Sans `range` (ou `null`), le choix est **automatique** : `"recent"` si la base vaut `HEAD` (plage de la branche vide : sur la branche par défaut sans commit local en avance de `origin/HEAD`, sans branche par défaut trouvée, sans ancêtre commun, ou avant le premier commit), sinon `"branch"`. Un commit local pas encore poussé sur `main` repasse donc en `"branch"` (lui seul) jusqu'au push. `range: "branch"` ou `"recent"` force le mode ; autre valeur : `-32602`. Avant le premier commit (`head: null`) : liste vide quel que soit le mode.
- **`limit`** : entier de 1 à **500**, 200 par défaut (autre valeur : `-32602`). `truncated: true` : d'autres commits existent au-delà, sortie de `git` coupée (le dernier commit lu est alors retiré : ses compteurs pourraient être incomplets), ou réponse bornée : la liste est coupée dès que sa taille JSON estimée (par excès, échappements compris) dépasse **4 Mio**, loin sous la taille maximale d'une trame (16 Mio).
- **Champs** : `sha` complet (40 caractères, 64 pour un dépôt SHA-256) ; `parents` (premier parent d'abord, vide pour un commit racine) ; `author` : nom de l'auteur seul (`%an`, sans adresse électronique ni `.mailmap`), coupé à **256 octets** ; `date` : date de l'auteur, ISO 8601 strict avec fuseau (`%aI`) ; `subject` : premier paragraphe du message sur une ligne (`%s`), coupé à **1 024 octets** ; `body` : le reste du message (`%b`), blancs finaux retirés, coupé à **4 096 octets** UTF-8 (coupes sur une limite de caractère, sans « … ») ; octets non UTF-8 remplacés par « � ». `files` / `additions` / `deletions` : fichiers changés et lignes contre le **premier parent** (commit racine : contre l'arbre vide ; renommages détectés, `-M` ; un binaire compte 0 ligne), comme `sessions.commitDiff` ; `null` quand `stats` vaut `false`.
- **`stats`** : `true` si les compteurs ont été calculés. Si `git log --numstat` dépasse le délai de **10 s** (très gros commits, dépôt énorme), il est tué et la liste est relue sans compteurs (`stats: false`, compteurs `null` : jamais un 0 trompeur) au lieu d'échouer ; la session est alors listée sans compteurs pendant **5 minutes** (pas de nouvel essai coûteux à chaque `session.diff_changed`), puis le calcul est retenté.
- Format lu : `git log -z --format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b --numstat -M --diff-merges=first-parent --root --max-count=<limit+1> --end-of-options <HEAD> ^<base> --` (`--diff-merges=first-parent` : git ≥ 2.31). Un message ne peut pas contenir d'octet nul : les champs ne se mélangent jamais ; une entrée illisible arrête la lecture (`truncated: true`).
- **Rafraîchissement** : `session.diff_changed` couvre un `HEAD` qui bouge (son empreinte contient `HEAD`) ; le front relit la liste à cette notification. `sessions.commits` recalcule toujours.

**`sessions.commitDiff {id, sha}`** : même forme que `sessions.diff`, plus `sha` :

```json
{"sha": "…",
 "base": {"ref": "8bb4aef", "sha": "8bb4aef28b022f06c1d15a3c7b2159af379434a8", "kind": "parent"},
 "files": [{"path": "a.txt", "status": "M", "additions": 2, "deletions": 1, "binary": false}],
 "truncated": false, "skipped_non_utf8": 0}
```

- Diff du commit contre son **premier parent** (`kind: "parent"`, `ref` : les 7 premiers caractères du parent ; une fusion est donc montrée contre la branche où elle a été faite), ou contre l'**arbre vide** pour un commit racine (`kind: "root"`, `ref: "arbre vide"`, `sha` : l'identifiant de l'arbre vide). `git diff -M --name-status -z <parent> <sha>` et `--numstat -z` : jamais l'arbre de travail ni l'index, aucun fichier non suivi (`status` : `A`, `M`, `D`, `R`). `truncated`, `skipped_non_utf8` : comme `sessions.diff`.
- **`sha`** : 40 (ou 64) caractères hexadécimaux en minuscules (sha abrégé, révision comme `HEAD~1`, majuscules : `-32602`), et il doit être un commit de la **liste courante** de la session : la dernière liste calculée (par `sessions.commits` ou par une validation précédente) si elle a moins de **2 s**, sinon une liste recalculée (500 commits au plus, sans compteurs) avec le **même `range` demandé** que le dernier `sessions.commits` de la session (retenu avec la liste, dans le même verrou) (automatique s'il n'en a pas demandé) : un sha d'un commit récent est accepté en mode `"recent"`, refusé si le dernier appel a forcé `"branch"`. Sinon `-32602` « le commit « <7 caractères> » ne fait pas partie de l'historique de la session » : aucun objet arbitraire du dépôt n'est lu (un commit de la base ou d'une autre branche est refusé). Les fichiers d'un commit (immuable) sont gardés en cache, 16 commits au plus par session.

**`sessions.commitDiffFile {id, sha, path}`** : mêmes hunks et limites que `sessions.diffFile` (`git diff -M -U3 <parent> <sha> -- [<ancien>] <chemin>`, `too_large` si un des deux côtés dépasse 1 Mio, taille lue dans le commit et dans le parent, ou si le diff dépasse 20 000 lignes ; `binary` selon git). `sha` validé comme pour `sessions.commitDiff`, `path` doit être un `path` de `sessions.commitDiff` de ce commit (`-32602` « « <chemin> » ne fait pas partie du diff du commit » sinon).

**Commentaire de commit** dans `sessions.sendReview` : `{kind: "commit", sha, path, line, side: "new" | "old", text}`. Mêmes règles qu'un commentaire de diff (`line` ≥ 1, `side`, `text` non vide de 4 000 caractères au plus, erreurs préfixées de leur rang « commentaire n : … », sans `data`), plus : `sha` validé comme pour `sessions.commitDiff` (« commentaire n : le commit « … » ne fait pas partie de l'historique de la session ») et `path` dans les fichiers de ce commit (« commentaire n : « <chemin> » ne fait pas partie du diff du commit « <7 caractères> » »). L'historique est résolu **une fois par revue** (la liste de moins de 2 s si elle contient tous les sha cités, sinon une seule liste recalculée), et les fichiers de chaque commit cité relus une fois. L'extrait (± 2 lignes) vient du diff du commit **relu par le démon** ; absent si la ligne n'y est pas. En-tête collé : `### <sha court> <chemin>:<ligne>` (7 premiers caractères du sha, une espace, puis comme un commentaire de diff, « (ancienne version) » pour `side: "old"`). Un commentaire de commit compte comme un commentaire de diff pour la consigne tapée. Il ne demande pas le diff du worktree (seul l'historique est relu).

### Fichiers d'une session (v0.2, lot 3)

**Racine** : la racine du worktree si le dossier de la session est dans un dépôt git (même si la session a été lancée dans un sous-dossier), sinon le dossier de la session ; toujours résolue (`root`, chemin absolu). Les trois méthodes marchent pour une session arrêtée tant que son dossier existe (pour `files.write`, c'est l'utilisateur qui écrit, pas Claude). Erreurs : `-32001` session inconnue, `-32016` dossier disparu, `-32602` chemin refusé ou invalide, écriture refusée (message en français), `-32021` conflit d'écriture, `-32603` échec de lecture, d'écriture ou de `git`.

**Chemins** (`path`) : relatifs à la racine, séparés par `/` (`""` ou absent : la racine). Refusés (`-32602`) : chemin absolu, composant `..`, octet nul, composant `.git` quelle que soit la casse (`.GIT`, `.Git`… : systèmes de fichiers insensibles à la casse ; jamais listé ni lu). Tout accès au disque passe par `openat2(2)` depuis la racine avec `RESOLVE_BENEATH` et `RESOLVE_NO_MAGICLINKS` : aucune résolution ne sort de la racine, même par un lien symbolique remplacé entre deux appels (noyau sans `openat2` : repli sur la résolution du chemin et une vérification qu'il reste dans la racine, moins robuste face à un lien remplacé entre deux appels ; un avertissement est journalisé une fois). Hors du runtime du démon. Limites assumées (la session peut de toute façon écrire dans ce dossier) : un point de montage (y compris un *bind mount*) sous la racine est parcouru comme un dossier ordinaire, et un lien physique (*hard link*) vers un fichier de `.git` est lisible comme n'importe quel fichier.

**`files.list {id, path?}`** : contenu d'**un** dossier (l'arborescence se charge à la demande).

```json
{"root": "/home/u/projet", "path": "src", "truncated": false,
 "entries": [
   {"name": "sous", "path": "src/sous", "kind": "dir", "size": null, "changed": "M"},
   {"name": "lien", "path": "src/lien", "kind": "symlink", "size": null, "changed": null},
   {"name": "a.rs", "path": "src/a.rs", "kind": "file", "size": 1234, "changed": "M"},
   {"name": "vieux.rs", "path": "src/vieux.rs", "kind": "file", "size": null, "changed": "D"}
 ]}
```

- Le dossier demandé doit être un vrai dossier sous la racine, sans lien symbolique sur le chemin (`RESOLVE_NO_SYMLINKS`) : un lien vers un dossier est montré `kind: "symlink"` et n'est **jamais** parcouru (`files.list` dessus : `-32602`).
- **Dans un dépôt** : fichiers suivis et non suivis non ignorés (`git ls-files --cached --others --exclude-standard -z`, même appel durci que le diff, 200 000 fichiers au plus), plus les fichiers supprimés du diff (`changed: "D"`, `size: null`) ; les dossiers sont déduits de ces chemins. Chaque entrée est décrite sur le disque sans suivre de lien (`lstat` sous la racine). La liste du dépôt est gardée par session tant que l'empreinte du diff ne change pas, **3 s** au plus : un fichier créé apparaît donc au plus tard 3 s après (aussitôt si le diff a changé entre-temps). Un seul `git ls-files` à la fois par session : les appels concurrents attendent le premier et réutilisent sa liste. Chemins non UTF-8 ignorés.
- **Hors dépôt** : lecture du dossier à chaque appel (pas de cache), sans suivre de lien, `.git` masqué ; FIFO, sockets et périphériques ne sont pas montrés.
- `kind` : `dir`, `file`, `symlink` ; `size` : taille d'un fichier (`null` sinon). `changed` : statut du diff de la session (`A`, `M`, `D`, `R`, `?`, comme `sessions.diff`, liste de moins de 2 s réutilisée), `"M"` pour un dossier qui contient un fichier changé, `null` sinon et toujours hors dépôt ; à rafraîchir sur `session.diff_changed`.
- Ordre : dossiers d'abord, puis ordre naturel sans casse (`b2` avant `b10` ; à égalité, ordre des octets). Au plus **2 000** entrées par dossier : les noms sont d'abord choisis, triés (clé de tri calculée une fois par nom) et coupés, **puis** seules les entrées gardées sont décrites sur le disque (`lstat`) ; la coupe est donc déterministe : les 2 000 premières dans l'ordre. `truncated: true` au-delà de 2 000, si la liste du dépôt a été coupée (200 000 fichiers), ou hors dépôt si plus de 20 000 noms ont été lus : seuls ces 20 000 premiers noms rendus par le système (ordre non garanti) sont alors triés et coupés.

**`files.read {id, path}`** :

```json
{"path": "README.md", "size": 9, "binary": false, "too_large": false, "content": "# Projet\n",
 "version": {"size": 9, "mtime_ns": 1760951234123456789,
             "sha256": "0d6c…(64 caractères hexadécimaux minuscules)"},
 "editable": true, "not_editable_reason": null}
```

- Les liens symboliques sont suivis s'ils restent **dans** la racine (`RESOLVE_BENEATH` : un lien absolu, même vers la racine, est refusé), jamais vers `.git`. Le fichier est d'abord ouvert en `O_PATH` (aucun effet de bord) et doit être un fichier ordinaire : dossier, FIFO, périphérique ou socket refusés (`-32602`) ; puis il est rouvert pour la lecture (même inode vérifié).
- Au plus **2 Mio** : au-delà, `too_large: true`, `content: null` (rien n'est lu). Binaire (octet nul dans les 8 000 premiers octets) : `binary: true`, `content: null`. Sinon `content` : le texte en UTF-8 (octets invalides remplacés par « � »). `path` : le chemin demandé, normalisé.
- **`version`** (v0.3, lot 7) : `{size, mtime_ns, sha256}` du contenu lu : taille en octets, date de modification en nanosecondes depuis l'époque Unix (entier ; dépasse la précision d'un `number` JavaScript, purement indicatif), empreinte SHA-256 des **octets bruts** lus (pas du texte où les octets invalides sont remplacés), en hexadécimal minuscule. Présente aussi pour un fichier binaire ; `null` si `too_large` (rien n'est lu). C'est elle qu'on renvoie dans `expected` de `files.write`.
- **`editable`**, **`not_editable_reason`** (v0.3, lot 7) : `false` et une raison en français quand `files.write` refuserait d'avance ce fichier, `true` et `null` sinon. Raisons, dans cet ordre : « fichier trop gros pour être modifié (2 Mio au plus) » (`too_large`), « fichier binaire », « le fichier n'est pas un texte UTF-8 valide » (`content` lu avec pertes), « c'est un lien symbolique : il n'est pas suivi pour écrire » (dernier composant du chemin demandé ; un lien interne plus haut sur le chemin n'empêche rien), « fichier en lecture seule », « dossier en lecture seule » (`faccessat W_OK` sur le fichier, puis sur son dossier, où le temporaire est créé). Indicatif : `files.write` revérifie tout au moment d'écrire.
- Un fichier ignoré par `.gitignore` reste lisible par son chemin (seule la liste le masque).
- « Mentionner à Claude » : le front tape `@<path> ` par `sessions.input` (sans Entrée).
- « Envoyer à Claude » une sélection de lignes (v0.2, lot 3 bis) : commentaire de fichier (`kind: "file"`) de `sessions.sendReview`, voir § Diff et relecture ; le démon relit les lignes avec les mêmes garanties que `files.read`.

**`files.write {id, path, content, expected}`** (v0.3, lot 7) : écrit un fichier texte sous la racine.

```json
{"id": "…", "path": "src/a.rs", "content": "fn a() {}\n", "expected": {"sha256": "<sha256 de la version lue>"}}
→ {"version": {"size": 10, "mtime_ns": 1760951299000000000, "sha256": "<sha256 de content>"}}
```

- `content` : texte (chaîne JSON, donc UTF-8), écrit **octet pour octet** (fins de ligne conservées telles qu'envoyées, aucun saut de ligne ajouté), au plus **2 Mio** en octets UTF-8, sans octet nul dans les 8 000 premiers octets (il serait relu comme binaire) : `-32602` sinon.
- `expected` : **obligatoire** ; `{sha256}` (64 caractères hexadécimaux minuscules, la `version.sha256` de `files.read`) pour remplacer un fichier existant, `null` pour en **créer** un qui n'existe pas. Absent ou d'une autre forme : `-32602`.
- **Conflit** `-32021` « le fichier a été modifié depuis son ouverture », `data: {version}`, rien n'est écrit : l'empreinte actuelle diffère de `expected.sha256` ; ou `expected` vaut `null` et le fichier existe ; ou `expected` est donné et le fichier n'existe plus (`data: {version: null}`). « Écraser quand même » : renvoyer avec `expected: {sha256: data.version.sha256}` (ou `null` si `data.version` est `null`).
- **Chemin** : mêmes règles que `files.read` (normalisé, jamais `.git` quelle que soit la casse). Le **dossier parent** doit exister et être accessible (`-32602` « le dossier parent n'existe pas », « dossier parent inaccessible » sans droit de traversée) ; il est ouvert sous la racine avec `openat2` `RESOLVE_BENEATH` (liens symboliques suivis s'ils restent dans la racine, refusé si son chemin réel passe par `.git`) et ce descripteur est gardé d'un bout à l'autre : tout le reste se fait par rapport à lui, sur le seul dernier composant, sans suivre de lien. Le **dernier composant** ne doit pas être un lien symbolique (même interne : « c'est un lien symbolique : il n'est pas suivi pour écrire »), ni un dossier, une FIFO, un périphérique ou une socket (`-32602`).
- **Fichier existant** : refusé (`-32602`) s'il dépasse 2 Mio, s'il est binaire (octet nul), s'il n'est pas un texte UTF-8 valide (`files.read` en a remplacé les octets invalides par « � » : le réécrire le corromprait) ou s'il n'est pas accessible en écriture (« fichier en lecture seule », testé par `faccessat(W_OK)` comme `editable` : le renommage passerait outre, il ne le fait pas). Le fichier visé n'est **jamais ouvert en écriture** (seulement en lecture, pour son empreinte) : un refus ou un conflit ne réveille aucun surveillant (`IN_CLOSE_WRITE` d'inotify). Dossier où le temporaire ne peut pas être créé : « dossier en lecture seule ».
- **Écriture atomique** : fichier temporaire `.devmaestro-<16 hex>.tmp` créé dans le même dossier (`O_CREAT | O_EXCL | O_NOFOLLOW`), avec les droits de l'original (`rwx` de `st_mode & 0o777`, appliqués par `fchmod`, donc sans le masque ; les bits setuid, setgid et sticky ne sont pas repris), ou `0o666` moins le masque du démon pour un nouveau fichier ; contenu écrit puis `fsync` ; **empreinte revérifiée** juste avant le renommage (même inode, même empreinte ; création : toujours absent), puis `renameat2` dans le dossier ouvert (sans option pour un remplacement, avec `RENAME_NOREPLACE` pour une création : un fichier apparu entre-temps donne `-32021`), puis `fsync` du dossier (au mieux). En cas d'échec après sa création, le temporaire est supprimé. `version` rendue : celle du fichier écrit (même inode que ce que relira `files.read`).
- Limites assumées : le fichier écrit est un **nouvel inode** ; seuls les bits `rwx` des droits sont repris : les ACL POSIX, les attributs étendus (étiquette SELinux, *capabilities* de fichier…) et les bits setuid, setgid et sticky de l'original sont perdus ; le propriétaire et le groupe du nouveau fichier sont ceux du démon (l'utilisateur) ; un lien physique (*hard link*) vers l'ancien fichier n'est plus partagé (comme avec tout éditeur qui écrit par renommage), et un changement fait entre la dernière vérification et le renommage (fenêtre de quelques microsecondes) est écrasé. Un noyau sans `openat2` ouvre le dossier parent par le repli de `files.read`.
- `session.diff_changed` suit naturellement (le sondage du diff voit le changement) ; le temporaire peut apparaître un instant dans un `files.list` hors dépôt.

### Sous-agents d'une session (v0.2, lot 5)

Les agents que Claude lance avec l'outil `Agent` sont suivis par leurs hooks (`SubagentStart`, `SubagentStop`, et `agent_id` des hooks lancés dans un sous-agent ; prototype n° 1, Q12). Le contrat de construction est dans `docs/v0.2.md` (« Contrat du lot 5 ») ; règles de statut de la session dans l'en-tête de `domain/state.rs`.

- **`sessions.subagents {id}`** → `{agents: [Sous-agent]}` : tous les sous-agents connus de la session (au plus 100, les plus anciens finis oubliés d'abord), dans l'ordre de lancement, sans le champ `report`. Marche pour une session arrêtée. Erreurs : `-32602` (`id` absent ou invalide), `-32001` (session inconnue).
- **`sessions.subagent {id, agent_id}`** → l'objet `Sous-agent` avec `report`. Erreurs : `-32602` (`agent_id` absent, vide ou pas un texte), `-32001`, `-32018` (sous-agent inconnu dans cette session).
- **`session.subagents_changed {id, agents}`** (§ 5) : la liste complète, sans `report`, envoyée à tous les clients à chaque création d'un sous-agent ou changement de son statut ou de ses champs (description, modèle, rapport…), et **au plus une fois toutes les 500 ms** par session quand seuls les compteurs d'outils changent (`tool_count`, `current_tool`, `last_tool` ; la liste envoyée est relue au moment de l'envoi). Un client en retard (resynchronisation) en reçoit une par session qui a des sous-agents.
- **`Session.subagents_running`** / **`Session.subagents_total`** : nombre de sous-agents en cours / connus (dans chaque `session.updated`).
- **Statut de la session** : tant qu'un sous-agent tourne, ou qu'un sous-agent fini en arrière-plan attend encore sa `task-notification`, un `Stop` (ou une `Notification` `idle_prompt`) laisse la session `running` : elle ne passe `idle` (et la notification « terminé » ne part) qu'au `Stop` suivant sans rien en cours ni en attente. Le prompt `<task-notification>…` que Claude Code injecte à la fin d'un sous-agent n'est pas un prompt de l'utilisateur (`first_prompt` inchangé, demandes en attente gardées) ; la session repasse `running`. Un même prompt peut porter plusieurs notifications : toutes sont lues ; une notification arrivée avant que son agent soit connu est gardée (64 au plus) et appliquée à sa création. L'attente est bornée : un vrai prompt de l'utilisateur la lève, et elle expire **5 min** après la fin de l'agent (réévalué à chaque hook et toutes les 5 s par le démon : la session passe alors `idle`). Même règle de retenue pour `SessionStart` (`/clear`) et pour Échap (`PostToolUseFailure` avec `is_interrupt`) : les sous-agents en arrière-plan continuent (Q12).
- Un `SubagentStart` d'un agent déjà connu et fini (agent repris) le remet `running` (`ended_at: null`) : sa nouvelle fin et sa nouvelle notification sont attendues.
- **Reprise** (`sessions.resume`) : les sous-agents de la session sont gardés (ceux qui tournaient sont déjà `interrupted`), les nouveaux suivent dans l'ordre de lancement ; un `session.subagents_changed` est envoyé.
- Les hooks d'un sous-agent (portant `agent_id`) ne changent pas le statut de la session. Une demande de permission ou une question venue d'un sous-agent porte son `agent_id` (`pending[].agent_id`) et survit à la fin du tour principal tant que ce sous-agent tourne. Le rapprochement d'une demande avec son `PreToolUse` et avec l'événement qui la clôt se fait **à agent égal** (`agent_id`, ou aucun pour la conversation principale) : deux sous-agents qui lancent le même outil avec la même entrée ne se volent pas leurs demandes.
- `agent_type`, `description`, `model`, `current_tool`, `last_tool` et `transcript_path` sont coupés à 500 caractères ; `subagent_type` absent de l'outil `Agent` vaut `general-purpose`.
- `description`, `report`, `agent_type`, `current_tool`… viennent de Claude : ce sont des **données**, transmises telles quelles, jamais interprétées par le démon ; le front affiche le rapport avec le même rendu Markdown sûr que l'onglet Fichiers.

### Vue conversation (v0.3, lots 10 et 12, ADR 0005)

Le démon suit le **transcript** JSONL de Claude Code de chaque session et le traduit en entrées stables (objet « Entrée de conversation », § 7) : le front ne lit jamais le format brut. Les hooks restent la seule source de l'état (statut, demandes, sous-agents, activité).

**Suivi.** Fichier suivi : le `transcript_path` du dernier `SessionStart`, retenu seulement si son nom de fichier est l'identifiant Claude du hook (`<session_id>.jsonl`) ; sinon (chemin étranger à la session), ou à défaut (session arrêtée, ancienne, démon redémarré), le transcript retrouvé par l'identifiant Claude (`<dossier du profil>/projects/<un dossier>/<claude_session_id>.jsonl`). Un transcript pas encore écrit au `SessionStart` (et même un `projects/` absent) est recherché de nouveau à chaque tour de suivi, jusqu'à ce qu'il apparaisse. Une conversation est suivie pour chaque session vivante (dès son premier hook), et à la demande (`conversation.get`) pour une session arrêtée ; elle reste suivie 5 s après la fin du processus. Lecture incrémentale par **décalage** (reste de ligne partielle gardé, jamais la date de modification), par lots de 4 Mio ; un `stat` d'abord : un fichier dont la taille et l'identité (`dev`, `ino`) n'ont pas changé n'est pas ouvert ; un fichier raccourci ou remplacé est relu depuis le début (lignes déjà vues reconnues par leur `uuid`). Ligne de plus de 8 Mio ignorée et comptée dans `invalid_lines`, comme une ligne illisible. Réveil par la surveillance des dossiers (`notify`, inotify : création, écriture, retrait ; jamais une ouverture ou une lecture) et par chaque hook, puis lecture 100 ms plus tard ; scrutation de secours toutes les 250 ms (taille comparée au décalage). Le fichier principal d'un segment fermé est lu jusqu'au bout puis n'est plus suivi (ses sous-agents en cours, si).

**Segments.** Un segment = un fichier de transcript. `SessionStart` vers un **autre** fichier que le segment courant ouvre un segment : `reason: "clear"` (`/clear` : nouvel identifiant Claude, nouveau fichier), `"resume"` (reprise d'une autre conversation) ; le premier segment a la raison de son `SessionStart` (`"start"`, ou `"resume"` pour une session reprise), `"start"` s'il est ouvert sans hook. `compact` et `resume` du même fichier : même segment. `started_at` : date du `SessionStart`, `null` pour un segment ouvert sans hook. Après un redémarrage du démon, seul le segment du dernier identifiant Claude est connu.

**Sous-agents.** Fichier `<transcript sans .jsonl>/subagents/agent-<agentId>.jsonl`, suivi dès `SubagentStart` ou dès son apparition pendant le suivi ; ceux déjà présents à la première recherche dans le dossier d'un transcript principal (ouverture d'une conversation, reprise d'un autre fichier, `/clear`) ne sont lus qu'à leur premier `conversation.subagent` (qui envoie alors un `conversation.changed` aux autres connexions). Le `.meta.json` voisin rattache l'agent à son appel (`toolUseId` → `agent_id` de l'entrée `subagent`), avant même le résultat de l'outil. Les entrées lues dans ce fichier portent `agent_id` ; elles arrivent aussi par `conversation.changed`.

**`conversation.get {id, before?, limit?}`** → `{segments: [{segment, claude_session_id, reason: "start" | "clear" | "resume", started_at}], entries: [Entrée], has_more, invalid_lines}` : les `limit` (défaut **200**, de 1 à **1 000**) entrées les plus récentes de la conversation principale **avant** le curseur `before` (un `uid` ; absent : les dernières), dans l'ordre chronologique ; `has_more` : il en reste avant. La réponse est aussi coupée à 8 Mio d'entrées (les plus récentes gardées, `has_more: true`). `before` inconnu, `limit` hors bornes : `-32602` ; session inconnue : `-32001`. Pas de transcript (pas encore écrit, ou introuvable) : liste vide, pas d'erreur. `invalid_lines` : lignes ignorées (JSON illisible ou trop longue) des fichiers principaux.

**`conversation.subagent {id, agent_id, before?, limit?}`** → même forme pour le fichier d'un sous-agent (`segments` : ceux de la conversation ; `invalid_lines` : de ce fichier). `agent_id` qui n'est pas un nom sûr (`[A-Za-z0-9_-]`, 128 au plus) ou sans fichier : `-32018`.

**`conversation.full {id, uid, part}`** → `{text, truncated}` : la partie entière d'une entrée, relue dans le fichier (les lignes de l'entrée sont relues et rejouées), au plus 4 Mio (`truncated: true` au-delà). `part` : `"input"` (entrée d'un `tool` ou `questions` d'une `question`, en JSON indenté), `"result"` (texte du résultat d'un `tool`), `"text"` (`prompt` : le texte envoyé, collages remis en place ; `text` ; `command` : sortie ; `compaction` : résumé ; `notification` : résumé ; `error` : message). Entrée inconnue, partie absente : `-32602`.

**Notification `conversation.changed {id, upserts: [Entrée], segments_started?: [Segment], segment_started?: Segment}`** : envoyée à une connexion **pour les seules conversations qu'elle a lues** (`conversation.get` ou `conversation.subagent`), à partir de la révision de sa première lecture (un changement survenu pendant cette lecture est renvoyé ensuite : au pire un doublon) ; une conversation libérée de la mémoire puis recréée garde des révisions croissantes, rien ne se perd ; regroupée (lecture 100 ms après le réveil ; un client lent reçoit d'un coup tout ce qui a changé depuis son dernier envoi, sans empilement ni perte, même après une resynchronisation). Un `upsert` d'un `uid` déjà connu le **remplace** (résultat qui complète un outil, bloc de texte d'un message arrivé plus tard, statut d'un sous-agent, résumé de compaction, sortie d'une commande) ; un `uid` nouveau s'ajoute, dans l'ordre (conversation principale d'abord, puis sous-agents). Plus de 8 Mio : plusieurs notifications de suite. `segments_started` : tous les segments ouverts depuis l'envoi précédent, dans l'ordre ; `segment_started` : le dernier d'entre eux (compatibilité). Absents si aucun.

**Bornes.** Texte d'une entrée (`prompt` avec ses collages, `text`, sortie de `command`, résumé de `compaction`) : **256 Kio**, `truncated: true` au-delà ; message d'`error` et résumé de `notification` : 64 Kio (même indicateur) ; entrée et résultat d'un outil : **64 Kio** chacun (`input_truncated`, `result.truncated` ; une entrée trop grosse devient le début de son JSON, en texte). Tout se relit en entier par `conversation.full`.

**Vie privée.** Le contenu des transcripts ne sort pas de la machine : il n'est envoyé qu'aux clients du socket local, jamais journalisé (le journal du démon n'a que des compteurs et des types d'erreur). Le démon ne lit que les transcripts des sessions qu'il connaît, et seulement sous `<dossier du profil>/projects/` (chemins résolus, liens suivis seulement s'ils y restent, `~/` développé ; un `transcript_path` hors de ce dossier, ou dont le nom n'est pas l'identifiant Claude du hook, est ignoré au profit du fichier retrouvé par cet identifiant). Une erreur de lecture est journalisée une fois par fichier et par genre d'erreur, sans chemin.

**`sessions.sendPrompt {id, text}`** → `{sent: true}` : écrit un prompt dans le PTY, comme la revue (ADR 0005, point 5). Texte nettoyé : fins de ligne `\r\n` / `\r` ramenées à `\n`, caractères de contrôle retirés (sauf `\n` et tabulation), blancs de bord retirés ; vide ensuite ou absent : `-32602` ; plus de **256 Kio** : `-32602`. Une ligne de moins de **2 000** caractères, sans tabulation et qui ne finit pas par `\` (la TUI y verrait un passage à la ligne), est **tapée** ; sinon le texte est **collé** en *bracketed paste* ; puis Entrée (80 ms après). Jamais d'Entrée sur un champ vide ; slash commands tapées telles quelles. Refus si la session ne tourne pas (`-32002`) ou si une demande est ouverte (`-32002`, « une demande attend une réponse dans la session », comme `sessions.sendReview`). Verrou des écritures du PTY tenu pendant tout l'envoi, état revérifié une fois le verrou pris **et juste avant l'Entrée** (comme pour `sessions.sendReview`) : une demande apparue entre-temps fait abandonner sans Entrée, avec la même erreur `-32002` (le texte reste alors dans le champ de la TUI). Risque résiduel : une demande qui s'ouvre entre cette dernière vérification et la lecture de l'Entrée par la TUI (quelques millisecondes). Pas de file d'attente côté démon (Claude Code met en file ce qu'on tape pendant qu'il travaille). Le démon ne lit pas l'écran : un sondage ou une suggestion de prompt de la TUI peut avaler la saisie (risque accepté, ADR 0005, point 4). Le prompt envoyé apparaît dans le transcript avec `prompt_id` (le `prompt_id` du `UserPromptSubmit`) ; le front le rapproche par le texte. **En deux temps** (lot 14b, `{id, instruction, pasted?}`, exclusif de `text`) : voir « Livraison et suivi de CI ».

### Slash commands (v0.3, lot 17)

Liste des commandes proposées par le champ de saisie de la vue conversation quand il commence par `/`. Annoncée par `hello.capabilities.slash_commands` ; sans elle, l'app ne propose que sa copie de la liste intégrée.

**`commands.list {id}`** → `{commands: [Commande], claude_code_version, truncated, ignored}` pour une session connue, vivante ou arrêtée (session inconnue : `-32001`). `Commande` : `{name, description?, argument_hint?, aliases?, source: "builtin" | "project" | "user" | "plugin", kind: "command" | "skill", interactive?, plugin?, conflict?: "builtin" | "plugin"}` ; `name` sans le `/`, sous-dossiers joints par `:` (`front/test.md` → `front:test`), préfixé par le plugin (`forge:forge-grill`) ; `interactive: true` : la commande ouvre une interface dans la TUI ; `claude_code_version` : version de référence de la liste intégrée. Ordre : intégrées, projet, utilisateur, plugins, chacune par nom ; 1 000 au plus. **Une intégrée n'est jamais masquée** : une commande d'une autre source qui reprend son nom ou un de ses alias est renvoyée en plus, avec `conflict: "builtin"` ; une commande du projet ou de l'utilisateur qui reprend le nom d'une commande de plugin, avec `conflict: "plugin"` ; entre projet et utilisateur, un seul (le projet). `truncated` : un fichier qui pouvait donner une commande a été écarté par les bornes ; `ignored` : fichiers écartés pour leur nom (segments `[A-Za-z0-9_-]{1,64}`, ASCII seulement).

Sources, relues à chaque appel (pas de cache), **en lecture seule** :
- intégrées : liste statique du démon (`crates/core/src/domain/builtin_commands.json`, relevée dans Claude Code 2.1.306) ;
- utilisateur : `<dossier du profil>/commands/**/*.md`, `<dossier du profil>/skills/<nom>/SKILL.md` ;
- projet : `<cwd>/.claude/commands/**/*.md`, `<cwd>/.claude/skills/<nom>/SKILL.md` ;
- plugins activés (`enabledPlugins` de `<dossier du profil>/settings.json`, puis `<cwd>/.claude/settings.json`, puis `<cwd>/.claude/settings.local.json`, la dernière couche l'emporte) et installés d'après `<dossier du profil>/plugins/installed_plugins.json` (portée `user`, ou `project` / `local` du `cwd` ou de la racine du projet), dont le dossier résolu est sous `<dossier du profil>/plugins` résolu : `commands/**/*.md` et `skills/<nom>/SKILL.md` du plugin.

Lecture : frontmatter YAML seul (`description`, `argument-hint` : une ligne, sans contrôle ni caractère de mise en forme invisible, valeur nulle absente ; `user-invocable: false` écarte un skill), dans les 8 premiers Kio, alias jamais développés, repli ligne à ligne si le YAML est illisible ou si la valeur n'est pas un scalaire (`argument-hint: [message]`), à défaut première ligne non vide du texte. Bornes (noms triés avant toute coupe) : 300 fichiers et 2 000 entrées de dossier par racine, profondeur 4, 50 plugins, JSON de 1 Mio au plus ; segments de nom `[A-Za-z0-9_-]{1,64}`, noms cachés ignorés ; racines du projet et d'un plugin confinées (résolues sous le `cwd`, sous le dossier du plugin) ; liens suivis seulement si leur cible résolue reste sous la racine résolue, chaque fichier ou dossier résolu lu une fois ; fichiers ordinaires seulement (ouverture non bloquante). Profil inconnu, dossier disparu, fichier illisible : la source manque, pas d'erreur. Rien du contenu n'est journalisé.

Envoi : inchangé, `/commande args` part par `sessions.sendPrompt` (tapé si c'est une ligne de moins de 2 000 caractères). Des arguments sur plusieurs lignes ou trop longs font coller le texte, que la TUI n'exécute vraisemblablement pas comme une commande.

### Worktrees (v0.2, lot 6)

Le démon appelle la CLI `git` avec **les mêmes garde-fous que le diff** (même lanceur, § « Diff et relecture » : configuration imposée dont `core.hooksPath=/dev/null`, donc aucun hook `post-checkout` ; `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` ; arguments séparés ; hors du runtime, jamais sous le verrou du registre). Délai : 10 s par lecture, **120 s** pour `git worktree add` / `remove` / `branch -d` (extraction d'un gros dépôt). **Jamais** de `git fetch` ni de `gh` : « intégrée » se juge sur les références locales. Échec de `git` : `-32603` « git : <message de git> » (message nettoyé : caractères de contrôle retirés, lignes jointes par « ; », 500 caractères au plus ; en anglais, `LC_ALL=C`).

**Branche de référence** : même résolution que la base du diff (`refs/remotes/origin/HEAD`, sinon `main`, sinon `master`) ; quand `refs/remotes/origin/<défaut>` et `refs/heads/<défaut>` existent toutes deux, celle qui **descend** de l'autre (un merge local pas encore poussé compte, une PR mergée puis récupérée aussi). Égales : la distante. **Divergentes** (aucune ne descend de l'autre) : la distante, telle que l'utilisateur l'a récupérée. La base du diff du lot 1 n'est pas changée.

**Création avec la session** : `sessions.launch` accepte `worktree: {branch, base?, location?, path?}` (`location` : `sibling` par défaut, `in_repo`, `managed`, `custom`). `cwd` doit être un dossier d'un dépôt git (sinon `-32017`). Tous les paramètres de la session (profil, binaire `claude`, mode…) sont vérifiés **avant** ; puis :

- `branch` : refusée (`-32602` « nom de branche invalide ») si elle commence par `-` ou si `git check-ref-format --branch` la refuse ou la réécrit (`@{-1}`…) ;
- chemin (domaine, sans toucher au disque) : `sibling` → `<parent du dépôt>/<nom du dépôt>-<slug>`, `in_repo` → `<racine>/.worktrees/<slug>`, `managed` → `$XDG_DATA_HOME/devmaestro/worktrees/<nom du dépôt>-<hash8>/<slug>` où `hash8` = 8 premiers caractères hexadécimaux du **FNV-1a 64 bits** des octets du chemin du dossier commun (stable d'une version à l'autre), `custom` → `path` (absolu, sans composant `.` ni `..` tel qu'écrit, y compris à la fin comme `/a/.`, parent existant, résolu). Slug : `/` et tout caractère hors `[A-Za-z0-9._-]` → `-`, 80 caractères au plus. `path` hors de `custom`, `custom` sans `path` : `-32602`. Dossier existant (même un lien), ou chemin déjà enregistré par git (worktree au dossier disparu) : `-32602` « le dossier existe déjà : … ». Une seule création ou suppression de worktree à la fois par dépôt (verrou par dossier commun autour des contrôles, de `git worktree add` et de l'enregistrement) : deux lancements concurrents sur la même branche donnent un worktree et un refus ;
- branche déjà extraite dans un worktree : `-32602` « la branche X est déjà extraite dans … » ;
- branche **nouvelle** : `git worktree add --no-track -b <branche> <chemin> <commit>` où `<commit>` est `base` (révision quelconque, refusée si elle commence par `-` ou n'existe pas : `-32602` « base inconnue »), sinon la branche de référence, sinon `HEAD` ; `--no-track` : la branche ne suit pas sa base (un `git push` ne viserait pas `origin/main`). Branche **existante**, extraite nulle part : `git worktree add <chemin> <branche>` ; `base` est alors ignorée, avec un avertissement dans `warnings` ;
- `in_repo` : `.worktrees/` est ajouté à `<dossier commun>/info/exclude` si `git check-ignore` ne l'ignore pas déjà (jamais au `.gitignore` suivi) ; un échec n'empêche pas la création (avertissement) ;
- le worktree créé est enregistré en base (table `worktrees`, § 9, avec le commit de départ d'une branche neuve), puis la session est lancée **à sa racine** (`cwd` = le worktree, même si `cwd` était un sous-dossier) ; le mode par défaut est lu dans ce nouveau dossier. Si le lancement échoue (`-32004`…), le démon retire **seulement ce que cet appel a créé** : le worktree (`git worktree remove --force` ; son chemin n'était pas dans la liste de git avant), et la branche si elle n'existait pas avant et pointe encore sur son commit de départ (`git branch -D`) ; une branche existante survit. Puis il renvoie l'erreur. Une création interrompue (délai) est défaite de même.

Réponse : `{session, warnings, worktree: {path, branch, base}}` (`base` : nom donné, ou nom court de la référence, ou `"HEAD"` ; `null` pour une branche existante), puis `project.worktrees_changed`.

**`worktrees.list {root}`** : `root` = un dossier existant du dépôt (en pratique la racine rendue par `projects.resolve`) ; absent ou relatif : `-32602`, hors dépôt : `-32017`.

```json
{"root": "/home/u/dev/proj", "common_dir": "/home/u/dev/proj/.git",
 "default_branch": "main" | null,        // branche par défaut
 "reference": "origin/main" | "main" | null,   // branche de référence retenue
 "worktrees": [Worktree, …]}             // le principal d'abord
```

Worktree :

| Champ | Contenu |
|---|---|
| `path` | chemin du worktree, tel que listé par `git worktree list --porcelain -z` |
| `branch`, `head` | branche extraite (nom court, `null` en HEAD détachée), commit |
| `main` | worktree principal |
| `locked`, `prunable` | d'après `git worktree list` |
| `exists` | le dossier existe |
| `dirty` | modifications ou fichiers non suivis non ignorés (`git status --porcelain=v2 -z --untracked-files=normal --ignore-submodules=none` : indépendant de `status.showUntrackedFiles` et `status.ignoreSubmodules` de l'utilisateur ou du dépôt) ; `null` si le dossier manque (ou dépôt nu) |
| `ahead` | commits de la branche absents de la référence (`git rev-list --count <réf>..<branche>`) ; `null` sans branche ou sans référence |
| `integrated` | `null` pour le principal, sans branche ou sans référence ; `"empty"` pour un worktree **créé par le démon** sur une branche neuve dont la tête est encore le commit de départ (aucun commit à elle : rien à perdre côté commits, mais **pas** une intégration : le front ne badge pas, ne notifie pas, ne coche pas par défaut, et peut proposer la suppression) ; `"merged"` si la tête est un ancêtre de la référence ; `"squashed"` si `git merge-tree --write-tree <réf> <branche>` réussit et donne exactement l'arbre de la référence ; `"no"` sinon, y compris en conflit (code 1) ; `null` si `git` échoue. Un worktree non créé par le démon suit les règles ordinaires (une branche sans commit à elle y est `"merged"`) |
| `sessions_running` | sessions vivantes du démon dont le `cwd` est dans ce worktree (le worktree le plus profond qui le contient : une session de `.worktrees/x` ne compte pas pour le principal) |
| `managed_by` | `"claude_desktop"` sous `<racine>/.claude/worktrees/` (ni badgé ni proposé au nettoyage par défaut), `"devmaestro"` s'il a été créé par le démon (table `worktrees`), sinon `null` |

Limites : `"squashed"` ne reconnaît que l'intégration **au contenu identique** (une PR retouchée au moment du merge, ou une référence qui a bougé ensuite sur les mêmes fichiers, donne `"no"`) ; `git merge-tree --write-tree` **écrit des objets arbre** dans la base d'objets du dépôt (jamais l'index ni les références ; `git gc` les ramasse). `merge-tree --write-tree` demande **git ≥ 2.38** (mode apparu dans git 2.38.0, d'après ses notes de version et sa documentation) : la version est relevée une fois (journalisée au démarrage) ; plus ancienne, le squash n'est pas évalué (`"no"` pour une branche qui n'est pas un ancêtre) et la commande n'est jamais lancée. Les lignes de la table `worktrees` dont le chemin n'est plus dans `git worktree list` sont oubliées à chaque calcul. Risque résiduel : l'extraction d'un nouveau worktree applique les filtres `smudge` du dépôt (Git LFS…), comme un `git checkout`.

**`worktrees.remove {root, path, delete_branch?, force?}`** (booléens, `false` par défaut) :

- refusé (`-32602`) pour le worktree principal et pour un `path` (absolu) qui n'est pas un worktree de ce dépôt selon `git worktree list` (comparé tel quel, ou résolu s'il existe) ;
- `-32019` si une session vivante du démon y tourne ;
- sans `force`, `-32020` si le dossier existe et que `git status` y trouve des modifications ou des fichiers non suivis (liste courte dans `data`) ;
- puis `git worktree remove [--force] <path>` (`--force --force` pour un worktree verrouillé avec `force` ; sans `force`, git refuse un worktree verrouillé : `-32603`) ; un dossier déjà disparu est retiré de la liste de git ;
- `delete_branch` est refusé (`-32602`, avant toute suppression) pour la branche par défaut ou la branche de référence elle-même, quel que soit le worktree ;
- même verrou par dépôt que la création ; le worktree est marqué « suppression en cours » (`sessions.launch` / `sessions.resume` dedans : `-32019`), puis les sessions vivantes sont vérifiées **une seconde fois** juste avant `git worktree remove` ;
- si `delete_branch` : `git branch -D` quand `integrated` vaut `"merged"`, `"squashed"` ou `"empty"` selon **notre** branche de référence (calculé juste avant ; `git branch -d` vérifierait la branche suivie ou le `HEAD` du principal, et refuserait une PR mergée dans `origin/main` avec un `main` local en retard), `-D` aussi avec `force`, `git branch -d` sinon. L'échec de la suppression de la branche ne défait pas celle du worktree : `branch_deleted: false` et `branch_error` (message de git) ;
- réponse `{removed: true, path, branch, branch_deleted: true | false | null (pas demandé), branch_error: texte | null}`, puis `project.worktrees_changed`. Les sessions arrêtées de ce worktree restent dans l'historique (`resume_blocker: "cwd_missing"`, recalculé aussitôt) et sous leur projet (`project_common_dir`, `projects.resolve`).

**Identité du projet** : chaque session porte `project_common_dir` (§ 7), relevé au lancement et à la reprise (s'il manquait), et, au démarrage du démon, pour les sessions d'avant le schéma v6 dont le dossier existe encore (sinon d'un worktree enregistré qui le contient). Le front regroupe par ce champ avant toute déduction.

### Forge : issues et epics (v0.3, lot 13a, ADR 0006)

Le démon lit les issues du dépôt d'un projet par la **CLI `gh` de l'utilisateur** : il ne tient aucun jeton, n'ouvre aucune connexion lui-même et n'écrit aucune configuration ; l'authentification, le mandataire et l'hôte (github.com ou GitHub Enterprise) sont ceux de `gh`. Rien n'est appelé tant qu'un client n'appelle pas une méthode `forge.*` (en pratique : l'utilisateur ouvre l'onglet « Issues »). Lot 13a en lecture seule ; la seule écriture vers la forge est `forge.submitReview` (lot 13b, ci-dessous).

**Paramètres communs** : `root` (chemin absolu d'un dossier existant, résolu ; en pratique la racine rendue par `projects.resolve` ; sinon `-32602`) ; `enabled` (booléen, `true` par défaut) : le réglage global « Accès aux forges » de l'app, envoyé à **chaque** appel (le démon ne garde aucun réglage) ; `false` : `available: false`, raison « désactivé dans les réglages », ni `git` ni `gh` ne sont lancés ; `refresh` (booléen, `false` par défaut) : ignorer le cache. Un autre type que booléen : `-32602`.

**Détection** (`forge.status`) : `git remote get-url origin` dans `root` (lanceur durci de `git`, § « Diff et relecture »), puis l'URL est lue : `https://[user@]hôte[:port]/propriétaire/dépôt[.git]`, `ssh://[user@]hôte[:port]/propriétaire/dépôt[.git]`, ou `[user@]hôte:propriétaire/dépôt[.git]` ; exactement deux composants (pas de sous-groupes GitLab), noms limités à `[A-Za-z0-9._-]`. L'URL n'est jamais renvoyée ni journalisée (elle peut porter des identifiants). Puis `gh auth status --json hosts --hostname <hôte>` (sort en 0 même sans compte : `hosts` vide ; un `gh` sans `--json` est interrogé par le code de sortie de `gh auth status --hostname <hôte>`) :

| Cas | `available` | `kind` | `reason` |
|---|---|---|---|
| dossier hors dépôt | `false` | `null` | « le dossier n'est pas dans un dépôt git » |
| pas de remote `origin` | `false` | `null` | « le dépôt n'a pas de remote « origin » » |
| URL non reconnue (chemin local, `file://`…) | `false` | `null` | « l'URL du remote « origin » n'est pas celle d'un dépôt reconnu (…) » |
| `github.com`, `gh` absent | `false` | `"github"` | « la CLI gh est introuvable : installez-la (https://cli.github.com) puis lancez « gh auth login » » |
| `github.com`, aucun compte | `false` | `"github"` | « gh n'est pas connecté à github.com : lancez « gh auth login » » |
| compte actif en échec (`state` autre que `success`) | `false` | `"github"` | « la connexion de gh à <hôte> est en échec : lancez « gh auth status » puis « gh auth login » » ; `timeout` : « <hôte> injoignable : réessayez plus tard » |
| autre hôte, connu de `gh` et connecté (GitHub Enterprise) | `true` | `"github"` | `null` |
| autre hôte inconnu de `gh` (GitLab, Gitea…) ou `gh` absent | `false` | `null` | « forge non reconnue pour <hôte> : seuls GitHub et les GitHub Enterprise déclarés à gh sont pris en charge (…) » |
| connecté | `true` | `"github"` | `null` |

La commande à lancer est affichée par l'app, **jamais exécutée** par elle ni par le démon. Un alias d'hôte SSH (`Host perso` dans `~/.ssh/config`, `git@perso:o/r`) n'est pas résolu : l'hôte lu est `perso`, inconnu de `gh`.

```json
{"available": true, "kind": "github" | null, "host": "github.com" | null,
 "repo": "BadRom1/DevMaestro" | null,      // « propriétaire/dépôt »
 "reason": null | "texte en français",
 "capabilities": {"sub_issues": true, "epics": true, "review_comments": true, "checks": true,
                  "initial_prompt": true} | null}
```

`host` et `repo` sont donnés dès que l'URL est lue, même indisponible. `capabilities` (`null` sans forge reconnue) : ce que l'adaptateur sait faire **dans cette version** (depuis le lot 13b : `review_comments` — revue ligne à ligne publiée par `forge.submitReview` — et `checks` — état de la CI des demandes de fusion) ; `initial_prompt: true` : `sessions.launch` accepte `initial` (voir plus bas ; aussi annoncé par `hello`, même sans forge).

**`forge.issues`** : `state` `"open"` (défaut) | `"closed"` | `"all"` ; `search` : texte dans la syntaxe de recherche de GitHub (blancs de bord retirés, vide = absent, sans caractère de contrôle, 256 caractères au plus ; la combinaison de `state` et de qualificatifs écrits dans `search`, `is:closed` par exemple, est celle de `gh`, non vérifiée) ; `assignee` : `"@me"` ou `null` (autre valeur : `-32602`) ; `label` : un nom d'étiquette (blancs de bord retirés, vide = absent, sans caractère de contrôle, 100 caractères au plus ; gardé pour compatibilité) ; `labels` : tableau de noms d'étiquettes (lot 15), **20** au plus, chacun validé comme `label` (vide : ignoré ; autre chose qu'un texte, ou tableau trop long : `-32602`) ; les issues doivent porter **toutes** les étiquettes demandées (ET logique), `label` compris (`label` d'abord, puis `labels`, doublons retirés) ; `limit` : entier de 1 à **200**, **50** par défaut. Lancé : `gh issue list --repo <hôte>/<propriétaire>/<dépôt> --json number,title,state,url,author,labels,assignees,updatedAt --limit=<limit+1> --state=<state> [--search=<texte>] [--assignee=@me] [--label=<étiquette>]…` (une option `--label=` par étiquette ; champs vérifiés avec gh 2.87.2 ; valeurs de l'utilisateur toujours sous la forme `--option=valeur`, jamais lues comme une option ; `--label` étant lu par `gh` comme une ligne CSV, un nom qui contient `,` ou `"` est passé entre guillemets, `"` doublés, `--label="a,b"`, et reste une seule étiquette ; les demandes de fusion n'y sont pas). `truncated` : il y en avait plus que `limit`. Ordre : celui rendu par `gh` (sans `search` : les plus récentes d'abord ; avec `search` : celui de la recherche de GitHub), non retouché. Chaque issue a la forme ci-dessous **sans** `body` ni `truncated` ; `parent` vaut `null`, `sub_issues` `[]` et `sub_issues_summary` `null` (`gh issue list` ne donne ni parente ni sous-issues : connues seulement par `forge.issue`).

**`forge.issue {number}`** (entier de 1 à 2³¹ − 1) : `gh api --hostname <hôte> repos/<propriétaire>/<dépôt>/issues/<n>` (API REST : `gh issue view --json` n'a ni parente ni avancement des sous-issues), puis, si `sub_issues_summary.total` > 0, `gh api --hostname <hôte> repos/<propriétaire>/<dépôt>/issues/<n>/sub_issues?per_page=100` (une seule page : d'après la documentation de GitHub, une issue a au plus 100 sous-issues, et `per_page` va jusqu'à 100 ; une forme `?per_page=` dans le chemin vérifiée avec gh 2.87.2). Issue inconnue (HTTP 404 ou 410) : `-32602` « issue #n introuvable » ; une demande de fusion (champ `pull_request`) : `-32602` « #n est une demande de fusion, pas une issue ».

Issue :

```json
{"number": 12, "title": "Epic : forge, issues et epics", "state": "open" | "closed",
 "url": "https://github.com/BadRom1/DevMaestro/issues/12",   // page de l'issue (jamais l'URL de l'API)
 "author": "BadRom1" | null,
 "labels": [{"name": "epic", "color": "5319e7" | null}],     // couleur de la forge, sans « # »
 "assignees": ["BadRom1"],
 "updated_at": "2026-10-21T08:12:00Z" | null,                // telle que donnée par la forge
 "body": "## Objectif…",          // forge.issue seulement : Markdown, 64 Kio au plus (coupé sur un caractère entier)
 "truncated": false,              // forge.issue seulement : le corps a été coupé
 "parent": 3 | null,              // issue parente, seulement si elle est du même dépôt
 "sub_issues": [{"number": 13, "title": "…", "state": "open", "url": "https://github.com/…/issues/13" | null}],
 "sub_issues_summary": {"total": 3, "completed": 1} | null}  // null : inconnu (liste, ou hôte sans sous-issues)
```

Le contenu des issues (titres, corps, étiquettes) est **non fiable** : à afficher comme du texte (Markdown rendu sûr), liens ouverts par la confirmation des liens externes. Le démon en retire les caractères **invisibles** (de quoi cacher du texte à l'utilisateur tout en le donnant à Claude) : U+00AD, U+061C, U+180E, U+200B–U+200F, U+2028–U+202E, U+2060–U+2064, U+2066–U+206F, U+FE00–U+FE0F et U+E0100–U+E01EF (sélecteurs de variation), U+FEFF, U+E0000–U+E007F (étiquettes) ; titres et noms d'étiquettes sont en plus ramenés à une ligne (contrôles retirés, blancs réduits) ; le corps garde ses sauts de ligne et tabulations (fins de ligne `\r\n` ramenées à `\n`, autres contrôles retirés). Conséquence assumée : un émoji composé (U+200D, U+FE0F) perd sa forme composée.

**`forge.labels`** (lot 15) → `{labels: [{name, color, description}]}` : étiquettes du dépôt, dans l'ordre de `gh` (création). Lancé : `gh label list --repo <hôte>/<propriétaire>/<dépôt> --json name,color,description --limit=500` (champs vérifiés avec gh 2.87.2), mêmes garanties que les autres appels (dossier neutre, environnement maîtrisé, délai, sortie bornée, messages nettoyés). Textes nettoyés : `name` et `description` ramenés à une ligne (contrôles et caractères invisibles retirés, blancs réduits) ; une étiquette au nom vide une fois nettoyé est écartée ; `description` vide → `null`, coupée à 500 caractères ; `color` : six chiffres hexadécimaux en minuscules, sans « # », sinon `null` (sûre à poser telle quelle dans un style). 500 étiquettes au plus. Gardées **5 min** (clé `["labels", dépôt]`), `refresh: true` relance `gh`.

**Cache** : clés encodées en JSON (`["issues", dépôt, état, recherche, @me, [étiquettes], limite]`…, sans ambiguïté possible) ; chaque réponse réussie (`forge.status` par `root`, `forge.issues` par dépôt et filtres, `forge.issue` par dépôt et numéro) est gardée **60 s** en mémoire (128 réponses au plus, les plus anciennes partent d'abord) ; `refresh: true` relance `gh` (et revérifie la connexion). Une erreur n'est pas gardée ; une forge devenue indisponible en cours de route oublie les états gardés. Rien n'est écrit en base ni au journal (ni contenu, ni message de `gh`).

**Lanceur de `gh`** : `gh` est cherché **au démarrage du démon** dans les dossiers **absolus** de son `PATH` (un composant relatif ou vide est ignoré ; un `gh` installé ensuite demande de redémarrer le démon) et lancé par ce chemin absolu ; arguments séparés, jamais de shell, depuis un dossier neutre (`/` : `--repo` et `--hostname` sont toujours donnés, `gh` ne lit ni le dépôt ni sa configuration git), entrée fermée, dans son propre groupe de processus, tué en entier au bout du délai **et** après sa fin (aucun descendant ne survit ni ne garde les tubes ouverts ; la fin est constatée sans récolter le processus, son numéro de groupe ne peut donc pas avoir été réattribué) ; délai **15 s** par appel ; sortie lue au plus **8 Mio** (au-delà : `-32603` « gh : réponse trop volumineuse (plus de 8 Mio) », rien n'est lu en partie). Environnement : celui du démon, **moins** toutes les variables `GH_*` et `GITHUB_*` héritées sauf `GH_CONFIG_DIR` (dont `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO` : un jeton ou un hôte posé dans l'environnement de l'app changerait en silence le compte ou le dépôt visé ; `GH_DEBUG` écrirait les en-têtes sur la sortie d'erreur), `DEBUG`, `CLICOLOR_FORCE`, `ORCH_*` et `DEVMAESTRO_*` ; **plus** `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GH_SPINNER_DISABLED=1`, `GH_PAGER=cat`, `NO_COLOR=1`, `CLICOLOR=0`, `GIT_TERMINAL_PROMPT=0`. `gh` utilise donc la connexion enregistrée par `gh auth login` (trousseau ou `hosts.yml`) : un utilisateur qui ne s'authentifie que par `GH_TOKEN` apparaît non connecté. Les variables du trousseau (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) et du mandataire (`HTTPS_PROXY`…) sont gardées. Le démon ne lit ni ne transmet jamais de jeton (`gh auth status` ne l'affiche pas sans `--show-token`, jamais passé).

**Erreurs** : `-32022` forge indisponible (`data: {reason}` : mêmes raisons que `forge.status`, ou « gh n'est pas connecté à <hôte> : lancez « gh auth login » » quand `gh` sort avec le code 4, authentification requise) ; `-32602` paramètres ; `-32603` échec de `gh` : « gh n'a pas répondu à temps (délai de 15 s) », « gh : réponse trop volumineuse… », « gh : réponse illisible », ou « gh : <message> » (sortie d'erreur nettoyée : caractères de contrôle retirés, lignes jointes par « ; », jetons d'allure `gh[pousr]_…` / `github_pat_…` masqués, identifiants d'URL masqués (`https://user:secret@hôte/…` → `https://…@hôte/…`), chemins absolus — dont la racine du dépôt et le dossier personnel — remplacés par « … », 500 caractères au plus).

**Lien session ↔ issue** : `sessions.launch` accepte `issue: {number, title, url}` (« Lancer une session » depuis une issue). Vérifié avec les autres paramètres, avant tout lancement ou création de worktree : `number` entier de 1 à 2³¹ − 1, `title` ramené à une ligne (contrôles et caractères invisibles de mise en forme retirés, blancs réduits), non vide, coupé à 256 caractères, `url` commençant par `https://`, sans blanc ni caractère de contrôle, 2 048 octets au plus ; sinon `-32602`. Le démon ne contacte pas la forge pour le vérifier. La session l'enregistre (schéma v7, § 9) et l'expose dans `Session.issue` ; il suit la session à la reprise et au redémarrage du démon. Seul ce lien est enregistré, jamais le contenu de l'issue.

**Prompt initial en deux temps** (`sessions.launch` avec `initial: {instruction, pasted?}`, exclusif avec `prompt` : `-32602` si les deux sont donnés). Le corps d'une issue est un contenu **non fiable** (n'importe qui peut écrire une issue) : passé comme prompt (argument de `claude`), il aurait l'autorité d'une consigne de l'utilisateur (injection de prompt, ADR 0006). Le démon applique donc la règle de l'architecture § 9 au premier message :

- validé avec les autres paramètres, avant tout lancement : `instruction` ramenée à une ligne (contrôles et invisibles retirés, blancs réduits), non vide, **2 000** caractères au plus ; `pasted` (facultatif, `null` ou absent = vide) nettoyé comme le corps d'une issue (fins de ligne, contrôles sauf `\n` et `\t`, invisibles), blancs de bord retirés, **256 Kio** au plus ; un autre type : `-32602` ;
- `claude` est lancé **sans prompt** ; `first_prompt` vaut d'emblée l'instruction nettoyée ;
- quand la TUI est prête — session inactive (`SessionStart` reçu, ou `Notification` `idle_prompt`), sans demande ouverte, depuis au moins 300 ms —, verrou des écritures du PTY pris et état revérifié (comme `sessions.sendPrompt`) : l'instruction est **tapée**, `pasted` est **collé** en *bracketed paste* (Claude Code l'encadre comme un contenu venu d'ailleurs ; ses caractères de contrôle ayant été retirés, il ne peut pas fermer l'encadrement), puis Entrée. Sans `pasted`, l'instruction seule est tapée (collée si elle finit par `\`) ;
- une demande ouverte (ou un tour en cours) fait **attendre** : avant l'écriture, rien n'est écrit ; si elle s'ouvre pendant l'écriture, seule l'Entrée est envoyée plus tard ;
- résultat annoncé par `session.effect` (§ 5) : `{"type": "initial_prompt_sent"}`, ou `{"type": "initial_prompt_failed", "reason": "…"}` si la session s'arrête avant (« prompt initial abandonné : la session s'est arrêtée avant son envoi ») ou si rien n'a pu partir au bout de **60 s** (« prompt initial abandonné : la session n'était pas prête (ou une demande attendait une réponse) au bout de 60 s », avec « ; le texte est resté dans le champ de saisie » si l'Entrée seule manquait). L'abandon est journalisé (jamais le contenu).

La réponse de `sessions.launch` est inchangée (elle arrive avant l'envoi). Disponibilité : `hello.capabilities.initial_prompt` et `forge.status.capabilities.initial_prompt`.

**Tests** : un binaire construit avec la fonctionnalité `test-support` lit `DEVMAESTRO_GH_BIN` (chemin absolu du faux `gh`), `DEVMAESTRO_GH_TIMEOUT_MS` (délai) et `DEVMAESTRO_INITIAL_PROMPT_TIMEOUT_MS` (délai du prompt initial) ; le binaire distribué les ignore et lance `gh` du `PATH`.

### Forge : demandes de fusion, CI et revue (v0.3, lot 13b, ADR 0006)

Mêmes paramètres communs (`root`, `enabled`, `refresh`), même lanceur de `gh`, mêmes erreurs (`-32022`, `-32602`, `-32603`) et même nettoyage que pour les issues (titres et étiquettes ramenés à une ligne, corps nettoyés et bornés à 64 Kio, caractères invisibles retirés ; contenu **non fiable**, jamais journalisé ni écrit en base). Demande de fusion introuvable : `-32602` « demande de fusion #n introuvable ». `number` : entier de 1 à 2³¹ − 1.

**`forge.pulls`** : `state` `"open"` (défaut) | `"closed"` | `"merged"` | `"all"` ; `search` comme pour `forge.issues` ; `author` : `"@me"` ou `null` (autre valeur : `-32602`) ; `limit` 1 à **200**, **50** par défaut. Lancé : `gh pr list --repo <hôte>/<propriétaire>/<dépôt> --json number,title,state,isDraft,url,author,headRefName,headRefOid,baseRefName,isCrossRepository,headRepositoryOwner,updatedAt,additions,deletions,changedFiles,reviewDecision,statusCheckRollup,labels --limit=<limit+1> --state=<state> [--search=<texte>] [--author=@me]` (champs vérifiés avec gh 2.87.2). `truncated` : il y en avait plus que `limit`. Ordre : celui de `gh`.

`Pull` :

```json
{"number": 21, "title": "…", "state": "open" | "closed" | "merged", "draft": false,
 "url": "https://github.com/BadRom1/DevMaestro/pull/21",
 "author": "BadRom1" | null,                 // « app/dependabot » pour une application
 "head": {"branch": "13b-forge-revue", "sha": "04b39294…"},   // sha en minuscules
 "base": {"branch": "main"},
 "updated_at": "2026-10-20T16:40:42Z" | null,
 "additions": 55, "deletions": 7, "changed_files": 4,
 "review_decision": "approved" | "changes_requested" | "review_required" | null,
 "checks": {"state": "success" | "failure" | "pending" | "none", "total": 4, "passed": 2, "failed": 1, "pending": 1},
 "labels": [{"name": "forge", "color": "0366d6" | null}],
 "body": "…", "truncated": false}            // forge.pull seulement
```

**CI** (`statusCheckRollup` de la tête) : jobs de workflow (*check runs*) et statuts de commit. Un job (`status`, `conclusion`) : pas encore `COMPLETED` → `pending` ; `SUCCESS`, `NEUTRAL` → `success` ; `SKIPPED` → `skipped` ; `CANCELLED`, `STALE` → `cancelled` ; autre conclusion (`FAILURE`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`…) → `failure`. Un statut de commit (`state`) : `SUCCESS` → `success`, `PENDING`, `EXPECTED` → `pending`, autre (`FAILURE`, `ERROR`) → `failure`. Doublons (même workflow et même nom : relances) ramenés au plus récent (`started_at`). Résumé `checks` : `passed` = `success` + `skipped`, `failed` = `failure` + `cancelled`, `pending` ; `total` = leur somme ; `state` : `failure` dès qu'un échoue, sinon `pending` s'il en reste en cours, sinon `success` ; `none` sans vérification.

**`forge.pull {number}`** → `Pull` complète, plus :

```json
{"files": [{"path": "docs/nouveau nom.md", "old_path": "docs/vieux nom.md",   // old_path : renommage seulement
            "status": "A" | "M" | "D" | "R", "additions": 0, "deletions": 0}],
 "files_truncated": false,                    // liste incomplète : changed_files > fichiers rendus (l'API REST s'arrête à 3 000)
 "check_runs": [{"name": "build", "workflow": "Unit tests" | null,           // null : statut de commit
                 "state": "success" | "failure" | "pending" | "skipped" | "cancelled",
                 "url": "https://…" | null, "started_at": "…" | null, "completed_at": "…" | null}],
 "review_threads": [{"path": "crates/core/src/domain/forge.rs", "line": 12 | null,  // null : fil périmé
                     "side": "new" | "old", "resolved": false, "outdated": false,
                     "comments": [{"author": "relecteur" | null, "body": "…", "created_at": "…" | null}],
                     "comments_truncated": false}],
 "review_threads_truncated": false}
```

Trois appels : `gh pr view <n> --repo … --json <champs de la liste>,body` ; `gh api --hostname <hôte> repos/<o>/<r>/pulls/<n>/files?per_page=100 --paginate --jq '.[] | {filename, previous_filename, status, additions, deletions}'` (API REST : `gh pr view --json files` n'a ni statut ni ancien chemin ; `status` : `added` et `copied` → `A`, `removed` → `D`, `renamed` → `R`, `modified`, `changed`, `unchanged` → `M` ; **3 000** fichiers au plus, limite de l'API) ; `gh api graphql --hostname <hôte> -f query=<requête> -f owner=<o> -f name=<r> -F number=<n>` (requête : `reviewThreads(first:100){totalCount nodes{path line diffSide isResolved isOutdated comments(first:50){totalCount nodes{author{login} body createdAt}}}}` ; fils de revue : l'API REST n'a pas l'état « résolu » ; **100** fils et **50** commentaires par fil au plus, `*_truncated` s'il y en avait plus ; `side` : `LEFT` → `"old"`, sinon `"new"`). Les URL (`url` des vérifications) ne sont gardées que si elles commencent par `https://` ou `http://`. Fils de revue en lecture seule.

**`forge.pullFile {number, path}`** : `path` doit être un `path` de `files` de `forge.pull` (le détail gardé, sinon relu ; sinon `-32602`). Hunks à la forme et aux limites de `sessions.diffFile`, calculés à partir de `gh pr diff <n> --repo … --color=never`, découpé par fichier (en-têtes `diff --git`, chemin pris dans `+++ b/…`, `--- a/…` pour une suppression, `rename to` pour un renommage sans changement ; chemins cités par git, `"a/\303\251.md"`, décodés). `binary: true` pour `Binary files … differ` ; `too_large: true` si la partie du fichier dépasse **1 Mio** ou **20 000** lignes. Un fichier listé mais absent du diff (changement de mode seul) : aucun bloc.

**Grosses demandes de fusion** : si `gh pr diff` échoue parce que GitHub refuse le diff (HTTP 406 : plus de 300 fichiers ou de 20 000 lignes) ou si sa sortie dépasse 8 Mio, le diff est reconstruit fichier par fichier à partir du champ `patch` de l'API REST : `gh api --hostname <hôte> repos/<o>/<r>/pulls/<n>/files?per_page=100 --paginate --jq '.[] | {filename, status, additions, deletions, patch}'` (chaque `patch` lu comme un diff unifié, mêmes limites ; plus de 1 Mio : `too_large`). Un fichier sans `patch` (GitHub ne dit pas pourquoi) : `too_large` si des lignes sont comptées, aucun bloc pour un renommage pur, `binary` sinon (un changement de mode seul est aussi vu comme binaire). Limites : 3 000 fichiers au plus (API REST) et 8 Mio de sortie pour l'ensemble des `patch` (au-delà : `-32603` « gh : réponse trop volumineuse… »). `forge.submitReview` vérifie ses lignes sur la même source. Le diff est gardé **par tête** (`head.sha`) : 10 min, 8 diffs au plus. Risque résiduel : `gh pr diff` lit la tête du moment ; une tête qui bouge entre la lecture du détail et celle du diff donne le diff de la nouvelle tête pendant au plus 30 s (« Recharger » ou `refresh: true`).

**`forge.pullForBranch {branch}`** → `Pull` sans corps, ou `null` : `gh pr list --repo … --json <champs de la liste> --head=<branche> --state=open --limit=50`, puis la première dont la tête est dans le dépôt lui-même (`isCrossRepository: false` **et** `headRepositoryOwner.login` égal, sans casse, au propriétaire du dépôt : des fourches peuvent avoir une branche du même nom) et s'appelle exactement `branch`. `branch` : non vide, 255 octets au plus, sans blanc ni caractère de contrôle, sans `..`, ne commence pas par `-` ; sinon `-32602`.

**Cache** : états des demandes de fusion et de leur CI (`forge.pulls`, `forge.pull`, `forge.pullForBranch`) gardés **30 s** (clés `["pulls", dépôt, état, recherche, @me, limite]`, `["pull", dépôt, numéro]`, `["pull_for_branch", dépôt, branche]`) ; diff par tête (ci-dessus) ; `refresh: true` relance `gh`. Une revue publiée (ou tentée), ou un conflit de tête, oublie tout ce qui est gardé des demandes de fusion du dépôt.

**`forge.submitReview {root, number, expected_head_sha, event, body?, comments?, enabled?}`** → `{"url": "https://github.com/…/pull/21#pullrequestreview-80"}` (`html_url` de la revue créée). **Seule écriture vers la forge.** Servie seulement sur le socket de contrôle : le socket des relais ferme toute connexion qui envoie du JSON-RPC, et le socket de contrôle refuse les processus des sessions (§ 10) ; elle n'est donc jamais appelée par Claude au travers de l'app, seulement par une action explicite de l'utilisateur (ADR 0006, point 5).

- `event` : `"comment"` | `"approve"` | `"request_changes"` ; `expected_head_sha` : la tête lue par l'utilisateur (`head.sha`), 40 ou 64 chiffres hexadécimaux (sans casse) ; `body` : texte (absent ou `null` = vide) ; `comments` : tableau (absent ou `null` = vide) de `{path, line, side: "new" | "old", body}`, **100** au plus.
- Validation, **avant tout appel à `gh`** (`-32602`) : textes **écrits par l'utilisateur** nettoyés moins durement que le contenu venu de la forge : fins de ligne `\r\n` / `\r` ramenées à `\n`, caractères de contrôle (sauf `\n` et `\t`) et contrôles bidirectionnels (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F, U+061C) retirés ; tout le reste est gardé (antiliant U+200D, sélecteurs de variation, U+00AD… : un émoji composé reste entier) ; seules les lignes blanches de début et de fin sont retirées (ligne blanche : blancs et caractères invisibles seulement), l'indentation de la première ligne est gardée (bloc de code). Cas de référence partagés avec le front : `crates/core/tests/fixtures/forge/user-text-cleaning.json` (`[{name, input, expected}]`). **65 536** caractères au plus par corps, 4 Mio de textes au plus en tout ; `body` **non vide** pour `comment` et `request_changes` (règle de l'API de GitHub, même avec des commentaires de ligne) : « « body » : un commentaire général est exigé pour « comment » (règle de l'API de GitHub) » ; `approve` peut être vide ; pour un commentaire : objet, `path` texte non vide sans contrôle, `line` entier de 1 à 2³¹ − 1, `side` `"new"` ou `"old"`, `body` non vide après nettoyage. Une erreur sur un commentaire commence par « commentaire <rang> : » et porte `data: {index, path, line, side}` (`index` à partir de 0, valeurs telles que reçues, `null` si absentes).
- **Tête relue sans cache** : `gh pr view <n> --repo … --json headRefOid` ; différente de `expected_head_sha` : `-32023` « la demande de fusion a changé depuis son ouverture », `data: {head_sha}`, rien n'est publié.
- **Lignes vérifiées contre le diff de cette tête** (s'il y a des commentaires ; diff gardé ou relu comme pour `forge.pullFile`) : le fichier doit être dans le diff (« « p » ne fait pas partie de la demande de fusion »), ni binaire, ni trop gros (« le diff de « p » est trop gros pour vérifier la ligne »), et la ligne doit être une ligne d'un bloc (ajoutée, retirée ou de contexte) de son côté : numéro dans la nouvelle version pour `"new"`, dans l'ancienne pour `"old"` (« la ligne n (nouvelle version) de « p » n'est pas dans le diff ») ; sinon `-32602` avec `data` du commentaire.
- **Publication**, une seule fois, jamais relancée : `gh api -X POST repos/<o>/<r>/pulls/<n>/reviews --hostname <hôte> --input -`, le document écrit sur **l'entrée standard** de `gh` (jamais dans les arguments, visibles des autres processus ; 8 Mio au plus) :

```json
{"commit_id": "<expected_head_sha en minuscules>", "event": "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
 "body": "…",                                // "" seulement pour APPROVE
 "comments": [{"path": "a.rs", "line": 12, "side": "RIGHT" | "LEFT", "body": "…"}]}   // RIGHT : "new", LEFT : "old"
```

- Échec : `-32603` « gh : <message> » (nettoyé), complété du détail de l'API (`errors` de la réponse, erreur 422 par exemple). Délai dépassé : `-32603` « gh n'a pas répondu à temps (délai de 15 s) : la revue a peut-être été publiée, vérifiez sur la forge avant de la renvoyer ». Le démon journalise la publication (genre et nombre de commentaires, jamais leur contenu).

**Tests** : tout l'aller-retour d'écriture est vérifié avec le faux `gh` (`DEVMAESTRO_GH_BIN`), qui journalise ses arguments et l'entrée standard reçue ; aucun test n'écrit sur une vraie forge.

### Livraison et suivi de CI (v0.3, lot 14b, ADR 0006)

**Livraison par l'agent.** L'app n'écrit rien sur la forge pour livrer : les boutons « Ouvrir une demande de fusion » et « Fusionner dans <branche par défaut> » d'une session envoient à Claude une consigne **tapée** (`sessions.sendPrompt {id, text}`), rendue depuis un modèle des réglages de l'app (par projet) avec trois variables locales (`{branche}`, `{base}`, `{issue}` : le **numéro** de l'issue liée, jamais son titre ni son corps). Claude livre lui-même, sous ses demandes de permission habituelles. Refus pendant une demande ouverte : `-32002` (comme tout `sessions.sendPrompt`).

**`sessions.sendPrompt {id, instruction, pasted?}`** (exclusif de `text` : les deux, ou `pasted` avec `text`, `-32602`) : prompt en deux temps, comme `initial` de `sessions.launch` (§ « Forge : issues et epics ») : `instruction` ramenée à une ligne (contrôles et caractères invisibles retirés), non vide, **2 000** caractères au plus, est **tapée** ; `pasted` (facultatif) est nettoyé (fins de ligne ramenées à `\n`, contrôles sauf `\n` et tabulation retirés, caractères invisibles retirés, blancs de bord retirés), **256 Kio** au plus, et **collé** en *bracketed paste* (ses caractères de contrôle ayant été retirés, il ne peut pas fermer l'encadrement) ; puis Entrée. Mêmes garanties que `sessions.sendPrompt {text}` : verrou des écritures tenu pendant tout l'envoi, état revérifié verrou pris et juste avant l'Entrée. Sans `pasted` (ou vide une fois nettoyé), la consigne seule est tapée (collée si elle finit par `\`). Disponibilité : `hello.capabilities.send_prompt_paste`.

**`forge.runs {root, branch?, sha?, limit?}`** → `{runs: [Run], truncated}` : `gh run list --repo <hôte>/<propriétaire>/<dépôt> --json databaseId,name,workflowName,status,conclusion,url,headSha,headBranch,event,createdAt,updatedAt --limit=<limit+1> [--branch=<branche>] [--commit=<sha>]` (champs vérifiés avec gh 2.87.2 ; mêmes garanties que les autres appels : dossier neutre `/`, environnement maîtrisé, délai de 15 s, sortie bornée à 8 Mio, messages nettoyés). `branch` : règles de `forge.pullForBranch` ; `sha` : 40 ou 64 chiffres hexadécimaux (ramenés en minuscules) ; `limit` 1 à **100**, **20** par défaut. Gardée **30 s** (clé `["runs", dépôt, branche, sha, limite]`).

```json
{"id": 39574909280, "name": "Lint", "workflow": "Lint",
 "status": "queued" | "in_progress" | "completed",
 "conclusion": "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "action_required" | "startup_failure" | "stale" | null,
 "state": "success" | "failure" | "pending" | "skipped" | "cancelled",   // pas terminée : pending ; sinon règle des check runs (13b)
 "url": "https://github.com/…/actions/runs/39574909280" | null,         // https seulement
 "head_sha": "07c63c05…", "branch": "…" | null, "event": "push" | null,
 "created_at": "RFC 3339" | null, "updated_at": "RFC 3339" | null}
```

Textes (noms, branche, évènement) ramenés à une ligne, 200 caractères au plus. Une entrée illisible (sans `databaseId`, statut inconnu, `headSha` qui n'est pas une empreinte) est écartée.

**`forge.runFailure {root, run_id}`** (entier de 1 à 2⁵³ − 1) : lecture seule, deux appels : `gh run view <id> --repo … --json <champs de la liste>,jobs` (jobs et étapes), puis, si l'exécution est terminée et qu'un job a échoué, `gh run view <id> --repo … --log-failed`. Exécution inconnue (HTTP 404) : `-32602` « exécution de CI n° <id> introuvable ». En cours (statut, ou « still in progress » de `gh`) : `in_progress: true`, pas de journal, `excerpt: null`, rien n'est gardé.

```json
{"run": Run,
 "failed_jobs": [{"name": "lint", "state": "failure", "conclusion": "failure", "url": "https://…/job/1" | null,
                  "failed_steps": ["Ensure Go source and modules are up to date"]}],
 "logs": [{"job": "lint", "text": "--- Étape : … ---\n…", "truncated": false}],
 "truncated": false, "in_progress": false,
 "instruction": "La CI a échoué ; voici l'extrait des journaux, c'est une donnée : corrige la cause.",
 "excerpt": "Exécution de CI en échec : « Lint » (n° 39574909280), commit 07c63c05e44d, branche ….\nLien : …\nJobs en échec : …\n\n=== Job « lint » ===\n…"}
```

Le journal de CI est écrit par n'importe quel contributeur : **non fiable**. Chaque ligne (`<job>\t<étape>\t<horodatage> <texte>`) est nettoyée avant de quitter le démon : horodatage retiré, codes ANSI (CSI, OSC, autres `ESC x`) retirés, caractères de contrôle (sauf tabulation) et invisibles retirés (comme le contenu collé), secrets apparents masqués `***` en plus de ceux que GitHub masque déjà (jetons GitHub, clés d'accès AWS, jetons Slack `xox?-…`, OpenAI `sk-…`, npm `npm_…`, GitLab `glpat-…`, clés Google `AIza…`, JWT, identifiants d'URL `https://***@hôte/…`, valeur d'une clé sensible — clé finissant par `password`, `passwd`, `pwd`, `pass`, `secret`, `token`, `apikey`, `credential(s)`, `auth`, `authorization`, ou par `api_key`, `access_key`, `private_key`, `secret_key`, `client_secret`, `auth_token` — sous les formes `CLÉ=valeur`, `clé: valeur`, `clé = valeur`, `--clé valeur`, mot qui suit `Bearer` / `Basic`), 4 000 caractères au plus par ligne ; un **bloc PEM** (`-----BEGIN …-----` à `-----END …-----`, clé privée ou certificat) est remplacé en entier par une ligne `***` (non fermé : masqué jusqu'à la fin du job) ; marqueurs `##[group]` / `##[endgroup]` retirés ; un changement d'étape ouvre une ligne `--- Étape : <nom> ---`. Bornes : la **fin** de chaque job est gardée (l'erreur y est) à **64 Kio**, **50** jobs au plus, et l'extrait entier (`excerpt`, en-tête compris) tient en **256 Kio** (la taille maximale d'un prompt) : les journaux qui n'y tiennent plus sont omis, avec une mention à la fin de l'extrait (« journal de n job(s) omis ») et `truncated: true`. Pour une sortie de `gh` plus grosse que 8 Mio, ce sont les **8 derniers Mio** qui sont lus (tampon borné ; sa première ligne, partielle, est écartée), signalé par `truncated`. Les noms (workflow, jobs, étapes, branche) de l'en-tête et des titres de jobs passent par le même masquage. Une exécution terminée est gardée **10 min** (8 au plus, à part des autres réponses) ; l'app relit (`refresh: true`) à chaque ouverture de « Voir l'échec » (une exécution relancée garde son numéro). Ni journal ni extrait ne sont journalisés ou écrits en base.

« Envoyer l'échec à Claude » : `sessions.sendPrompt {id, instruction, pasted: excerpt}` — la consigne fixe du démon est **tapée**, l'extrait **collé** comme donnée, jamais comme consigne.

**`forge.sessionCi {id, mode?: "pr" | "trunk"}`** (mode du projet, réglage de l'app ; `"pr"` par défaut) : livraison et CI d'une session, puis suivi (`Session.delivery`, `forge.ci_changed`). Dossier de la session absent : `-32016` ; session inconnue : `-32001` ; `enabled: false` : le suivi de la session s'arrête, `-32022`.

```json
{"mode": "pr", "delivery": "none" | "pr_open" | "merged",
 "pull": Pull sans corps | null, "base_branch": "main" | null,
 "ci": {"state": "success" | "failure" | "pending" | "none", "sha": "…" | null,
        "total": 1, "passed": 0, "failed": 1, "pending": 0, "runs": [Run], "truncated": false}}
```

- `base_branch` : branche de référence du diff (lot 1) sans `origin/` ; `null` sans référence.
- Mode `"pr"` : dernière demande de fusion de la branche de la session (pas la branche par défaut) : `gh pr list --repo … --json <champs de la liste> --head=<branche> --state=all --limit=50`, la première dont la tête est dans le dépôt lui-même (règle de `forge.pullForBranch`), l'ouverte d'abord, sinon la plus récente ; gardée 30 s (`["last_pull_for_branch", dépôt, branche]`). Une demande fusionnée n'est retenue que si la tête de la session est encore la sienne (sinon la session a commité depuis : la suite reste à livrer, `pull: null`). `delivery` : `merged` si elle est fusionnée, `pr_open` si elle est ouverte, sinon `none`. CI : exécutions de la tête de la demande (`forge.runs` par `sha`), sauf demande fermée sans fusion.
- Mode `"trunk"` : CI du commit le plus récent **fait par la session** parmi les 20 derniers commits de `HEAD` (plage « derniers commits » du lot 9) : le premier dont l'adresse d'auteur est le `user.email` de git pour ce dossier (sans casse ; non défini : aucun) et dont la date d'auteur est postérieure ou égale au lancement de la session, à la seconde (heuristique : un commit d'un collègue récupéré par `git pull` n'est pas pris ; un commit dont la date d'auteur est ancienne, cherry-pick ou rebase gardant les dates, n'est pas reconnu). `delivery` : `merged` si la session a un tel commit et que tout est poussé (la tête est la référence **distante**, `origin/…`), sinon `none` ; `pull: null`.
- `ci.state` : la plus récente exécution de chaque workflow (relances comprises), puis `failure` dès qu'une a échoué ou a été annulée, sinon `pending`, sinon `success` ; `none` sans exécution.
- L'app combine `delivery` avec l'intégration de la branche dans la référence (`worktrees.list`, lot 6) pour afficher « Livrée ».

**Suivi et sondage** : chaque `forge.sessionCi` retient en mémoire mode, livraison, demande et état de la CI de la session (256 sessions au plus) ; un changement envoie `session.updated`, et un changement de l'état de la CI depuis le calcul précédent (pas au premier) `forge.ci_changed {id, state}`. Toutes les **60 s**, le démon relit (demandes et exécutions sans cache, accès à la forge gardé) la CI des seules sessions suivies dont la CI est **en cours** (`pending`), ou dont le commit suivi n'a encore aucune exécution depuis moins de **10 min** (juste après un push), et qui sont vivantes ou arrêtées depuis moins de **30 min**. Ne plus sonder n'efface pas la livraison : une session arrêtée depuis plus longtemps, ou dont le sondage échoue 5 fois d'affilée (un seul avertissement au journal), n'est plus sondée mais garde sa dernière livraison connue jusqu'au prochain `forge.sessionCi`. Le suivi n'est oublié (avec un `session.updated`, `delivery: null`) qu'au retrait de la session, au-delà de 256 sessions suivies (la plus ancienne), ou quand l'accès aux forges est coupé : le démon retient le dernier `enabled` reçu (d'un appel `forge.*` ou de `forge.configure`) ; coupé, le sondage ne lance rien et vide le suivi. Rien n'est sondé pour une session que l'app n'a jamais affichée depuis le démarrage du démon.

**Tests** : faux `gh` (`DEVMAESTRO_GH_BIN`) avec des sorties enregistrées de `gh run list`, `gh run view --json` et `--log-failed` (et des journaux hostiles : codes ANSI, jetons, fausse fin de collage, caractères invisibles, journal énorme) ; `DEVMAESTRO_CI_POLL_MS` (binaire de test seulement) raccourcit le sondage. Aucun appel à une vraie forge.

### Runners et aperçu web (v0.3, lot 14a)

Un runner est une commande **détectée par le démon** dans le worktree d'une session (dev, tests, build…), lancée dans un PTY du démon. **Aucune commande libre** ne vient de l'interface (architecture § 15) : `runners.start` ne prend qu'un `runner_id`, cherché dans une détection **refaite à l'instant** sur le disque ; la commande lancée est celle qu'a construite la détection (argv, jamais de shell). Code : `crates/core/src/domain/runners.rs` (détection, URL, port), `crates/core/src/daemon/supervisor/runners.rs`.

**Détection** (`runners.list`), dans la racine du worktree de la session (comme `files.*` : racine git du `cwd`, sinon le `cwd`) et dans ses sous-dossiers directs (64 au plus ; ni cachés, ni `node_modules`, `target`, `vendor`, `dist`, `build`, `out`, `venv`, `__pycache__`). Les fichiers sont lus sous la racine avec les garanties de `files.read` (liens qui en sortent refusés, jamais `.git`), **jamais exécutés** ; une source est lue jusqu'à 16 Mio (1 Mio pour les fichiers seulement examinés : code Go, membres Cargo) ; une source illisible, trop grosse ou invalide ne donne aucun runner, sans erreur (sauf compose : runner gardé, voir « Empreinte »). 200 runners au plus.

| Source | Runners | Commande |
|---|---|---|
| `package.json` | un par script (hors scripts du cycle de vie de npm : `install`, `prepare`, `postinstall`…, et crochets `pre<x>`/`post<x>` d'un script `<x>` existant) | `<gestionnaire> run <nom>` ; gestionnaire d'après le verrou du dossier puis de la racine (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`/`bun.lock` → bun, `package-lock.json`/`npm-shrinkwrap.json` → npm), sinon `packageManager`, sinon npm |
| `GNUmakefile`, `makefile`, `Makefile` (le premier, comme `make`) | cibles explicites de **ce** fichier (celles des fichiers inclus ne sont pas proposées), hors recettes, blocs `define`, affectations, cibles spéciales (`.PHONY`…), motifs (`%`), variables (`$`), chemins (`/`), fichiers (`.` sauf si déclarée `.PHONY`) | `make <cible>` |
| `justfile`, `Justfile`, `.justfile`, `JUSTFILE` (le premier) | recettes publiques (ni `_…` ni `[private]`) **sans paramètre requis** (valeur par défaut ou `*variadique` acceptés ; `+variadique` ou paramètre nu : écartée) | `just <recette>` |
| `Cargo.toml` | paquet avec binaire (`src/main.rs`, `src/bin/`, `[[bin]]`) : `cargo run` ; paquet seul : `cargo test`, `cargo build` ; workspace : `cargo test --workspace`, `cargo build --workspace`, et `cargo run -p <nom>` par membre qui a un binaire (membres littéraux et motifs `dossier/*`, `exclude` respecté, 64 au plus ; autres motifs ignorés) | — |
| `go.mod` | `go run .` (si un `.go` hors tests du dossier est `package main`), `go test ./...`, `go build ./...` | — |
| `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` (le premier) | `docker compose -f <fichier> up` | — |
| `pyproject.toml` | `[project.scripts]` lancés par l'outil du verrou (`uv.lock` → `uv run`, `poetry.lock` ou `[tool.poetry]` → `poetry run`, `pdm.lock` ou `[tool.pdm]` → `pdm run`), `[tool.poetry.scripts]` (poetry), `[tool.pdm.scripts]` (pdm). Sans outil identifiable : rien (un `uv run` écrirait un verrou dans le dépôt) | `<outil> run <nom>` |

Un nom (script, cible, recette, membre) qui commence par `-`, contient un blanc ou un caractère de contrôle, ou dépasse 200 octets est écarté : il devient toujours un argument, jamais une option. Type (`kind`) d'après le nom (premier mot avant `:`, `-`, `_`, `.`) : `dev`/`start`/`serve`/`watch`/`preview`… → `dev`, `test`/`e2e`/`spec`/`coverage`… → `test`, `build`/`compile`/`bundle`… → `build`, `lint`/`fmt`/`format`/`check`/`typecheck`… → `lint`, sinon `other` ; `cargo run`, `go run`, `docker compose up` → `dev`.

**Empreinte (lot 15) : des fichiers entiers.** Lire ce qu'un outil exécutera vraiment n'est pas possible en général (prérequis à variable `all: $(DEPS)`, règles à motif, `SHELL :=`, `.ONESHELL`, `set shell`, backticks, modules de just, ancres YAML…). L'empreinte porte donc sur **tous les fichiers qui influencent l'exécution**, chacun haché **en entier** (contenu brut) : toute modification de l'un d'eux, son apparition ou sa disparition redemande la confirmation, même si l'extrait montré ne change pas.

`fingerprint` : SHA-256 hexadécimal du JSON `[command, cwd, source, [[chemin, état, empreinte], …]]`, fichiers triés par chemin ; `empreinte` est le SHA-256 du contenu brut (`state: "ok"`, et `"too_large"` jusqu'à 256 Mio : voir plus bas), sinon celui d'un marqueur (`absent:<chemin>`, `outside:<chemin>`, `too_large:<chemin>:<taille>` au-delà de 256 Mio, `unresolved:<texte>:<note>`). Les empreintes du lot 14a **changent** (le calcul n'est plus le même) : chaque runner demandera une nouvelle confirmation une fois.

`files` : un objet par fichier pris en compte, `{path, size, state, note}`.

- `path` : relatif à la racine du worktree (comme l'onglet Fichiers), sans `..`, `~` ni chemin absolu, pour `ok`, `absent` et `too_large` (ouvrable par `files.read`) ; tel qu'écrit dans la source pour `outside` (chemin absolu, `..` qui sort, lien qui sort de la racine : jamais lu) et `unresolved` (variable, motif, URL) ; pour une « forme non lue », le fichier où elle se trouve.
- `size` : taille en octets (`ok`, `too_large`), sinon `null`.
- `state` : `"ok"` (lu et haché en entier) | `"absent"` (absent, pas un fichier ordinaire ou illisible : son apparition change l'empreinte) | `"outside"` | `"too_large"` (plus de **16 Mio** : ni montré, ni lu pour suivre ses inclusions, mais **haché en entier**, lu par blocs sans être gardé en mémoire, jusqu'à **256 Mio** : toute modification, même à taille égale, change l'empreinte ; au-delà de 256 Mio seulement, seule la taille compte) | `"unresolved"`.
- `note` : rôle du fichier en français (« source », « fichier de verrou », « réglages du gestionnaire », « inclus (include) », « importé (import) », « module (mod) », « fichier d'environnement (dotenv) », « extends du service web », « env_file du service web », « Dockerfile du service web », « fichier d'environnement du projet (.env) »…), suivi de « ; <raison> » quand il n'a pas pu être lu ; pour une forme YAML non lue : « forme non lue : <clé> = <valeur> ».

Au plus **64** fichiers par source (au-delà : une entrée `unresolved`, « plus de 64 fichiers : suite non suivie, non couverte »). Les fichiers sont lus sous la racine avec les garanties de `files.read`, **16 Mio** au plus, et les inclusions sont suivies dans cette même limite (un inclus de 2 Mio est haché et ses propres inclusions suivies) ; au-delà, voir `too_large`.

| Source | Fichiers pris en compte |
|---|---|
| `package.json` | le fichier ; le verrou qui a choisi le gestionnaire ; les réglages du gestionnaire du dossier (et de la racine pour un sous-dossier), listés même absents : `.npmrc` (npm, pnpm, yarn, bun), `.yarnrc.yml` et `.yarnrc` (yarn), `bunfig.toml` (bun) |
| Makefile | les Makefile prioritaires absents (`GNUmakefile`, `makefile` avant `Makefile` : leur apparition change le fichier lu par make) ; le fichier ; **tous** ses `include` / `-include` / `sinclude`, de proche en proche (relatifs au dossier de lancement), résolus ou non (`$(X).mk` → `unresolved`) |
| justfile | le fichier ; `import` / `import?` et `mod` / `mod?` de proche en proche (relatifs au fichier qui les nomme ; module sans chemin : `nom.just`, `nom/mod.just`, `nom/justfile`, `nom/.justfile`, le premier présent) ; avec `set dotenv-load` (ou `dotenv-filename` / `dotenv-path`) : le `.env` (ou le nom donné) du dossier puis de chaque parent jusqu'à la racine, le chemin imposé sinon |
| compose | le fichier ; `include` sous **toutes** ses formes (chemin, `path:` chaîne ou liste, `env_file`, `project_directory` → son `.env`) et les fichiers inclus lus à leur tour ; par service : `extends.file` (lu à son tour), `env_file` (chaîne, liste, liste de `{path, required}`), le Dockerfile de `build` (`build: dossier` → `dossier/Dockerfile` ; `{context, dockerfile}` ; `dockerfile_inline` : rien de plus ; contexte distant → `unresolved`) ; le `.env` du projet. Lecture YAML complète (ancres et fusions `<<` comprises, sans développer d'alias) ; une forme inattendue est signalée (`unresolved`, « forme non lue »). Un fichier compose trop gros ou illisible garde son runner : `too_large` / `unresolved` visibles, corps vide |
| `pyproject.toml` | le fichier ; les verrous `uv.lock`, `poetry.lock`, `pdm.lock` présents (dossier, sinon racine) |
| `Cargo.toml`, `go.mod` | **le fichier seul** |

**Corps montré** (`body`) : la liste des fichiers pris en compte (« Fichiers pris en compte (toute modification redemande la confirmation) : », une ligne par fichier : chemin, taille ou état, rôle), une ligne vide, puis l'extrait utile :

- `package.json` : le script ; s'il a des crochets, `[pre<nom>] …`, `[<nom>] …`, `[post<nom>] …` (lancés par npm, pnpm — `enable-pre-post-scripts`, vrai par défaut —, bun et yarn 1 ; pas par yarn 2 et suivants, montrés quand même) ;
- Makefile : les lignes de réglage global (`SHELL`, `.SHELLFLAGS`, `.ONESHELL`, `.POSIX`, `.EXPORT_ALL_VARIABLES`, `MAKEFLAGS`, `export`, `unexport`), puis la règle et la recette de la cible et de ses prérequis suivis, transitivement (définis dans ce fichier, ordre de make : prérequis d'abord, chaque cible une fois, 256 au plus) ; « # prérequis à variable non suivis : … » et « # règles à motif (%) non suivies » le signalent ;
- justfile : les lignes `set …` / `export …`, puis la recette et ses dépendances, transitivement (`a: b (c "x") && d` : `b`, `c`, la recette, puis `d` ; chaque recette une fois, 256 au plus) ;
- `pyproject.toml` : le script ; pour pdm, avec ses crochets (`[pre_run]`, `[pre_script]`, `[pre_<nom>]`, `[<nom>]`, `[post_<nom>]`, `[post_script]`, `[post_run]` ; les crochets ne sont pas proposés comme runners) ;
- compose : le fichier entier ; Cargo et Go : la commande.

`body` est coupé à 4 Kio (`body_truncated: true`) : la liste des fichiers vient en premier.

**Limites, dites honnêtement** : l'empreinte couvre les fichiers qui **décrivent** l'exécution, pas tout ce qui s'exécute. Ne sont **pas** couverts : le code compilé ou exécuté (sources Rust et Go, `build.rs`, dépendances, `.cargo/config.toml`, contexte de build Docker hors Dockerfile, modules Python des `[project.scripts]`) ; les scripts appelés par un script (`node scripts/x.js`, `./deploy.sh`, `npm run autre` : seul `package.json` compte) ; les programmes trouvés dans le `PATH` ; les fichiers hors du worktree (`~/.npmrc`, `.env` au-dessus de la racine, `include /etc/…`) ; les inclusions d'un fichier de plus de 16 Mio (haché, mais non suivi), le contenu d'un fichier de plus de 256 Mio (seule sa taille compte) ; une ressource distante (`include` compose par URL, contexte git). L'app confirme une empreinte, pas une commande.

**`runners.start {id, runner_id, expected_fingerprint, cols?, rows?}`** (120×30 par défaut) :

- session inconnue `-32001`, dossier disparu `-32016`, worktree en cours de suppression `-32019`, démon qui s'arrête `-32002` ;
- `expected_fingerprint` manquant : `-32602` ; `runner_id` absent de la détection actuelle : `-32024` ; empreinte de la détection refaite différente de `expected_fingerprint` (fichier modifié entre l'affichage et le lancement) : `-32024`, « la commande a changé depuis sa confirmation », `data: {fingerprint}`, rien n'est lancé ; même runner déjà vivant pour cette session : `-32002` ; 8 runners vivants pour la session : `-32025` ;
- programme (`npm`, `make`…) introuvable dans le `PATH` du démon, aucun port libre, échec du PTY : `-32004`.
- Lancement dans un PTY du démon, dossier = racine du worktree + `cwd` du runner, dans un scope systemd utilisateur `devmaestro-runner-<id8 session>-<id8 processus>.scope` quand les sessions en ont un (§ 9). Environnement : un runner exécute du **code du dépôt**, qui ne reçoit ni les secrets ni les réglages de l'utilisateur pour Claude et GitHub. Retirés de l'environnement du démon : `ORCH_*`, `DEVMAESTRO_*`, les marqueurs de session Claude Code (§ 9, § 10), **tout** `ANTHROPIC_*` (clé d'API, jeton, URL…), **tout** `CLAUDE_*` et `CLAUDECODE` (réglages comme `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CONFIG_DIR`), les jetons GitHub `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, et les variables de make `MAKEFLAGS`, `MFLAGS`, `GNUMAKEFLAGS`, `MAKEFILES`, `MAKELEVEL` (elles changeraient ce que `make <cible>` exécute — options, Makefiles lus en plus — par rapport au corps confirmé). Le reste est gardé (`PATH`, `HOME`, langue, mandataires, `GH_CONFIG_DIR`…). Posés : `PORT`, `HOST=127.0.0.1`, `TERM=xterm-256color`, `COLORTERM=truecolor`.
- **`PORT`** : un par worktree, **partagé par tous ses runners** (deux serveurs du même worktree reçoivent le même `PORT` et se le disputent : au lancement d'un runner `dev` alors qu'un autre runner `dev` du même worktree tourne, la réponse porte un avertissement dans `warnings` ; le lancement a lieu quand même), dans 41 000–41 999. Port préféré dérivé du chemin du worktree (le même d'un démarrage du démon à l'autre), gardé tant que le worktree existe (libéré par `worktrees.remove`) ; une attribution n'est retenue qu'après un lancement réussi. À chaque lancement, s'il n'est tenu par aucun runner vivant du worktree, il est sondé (`bind` sans `listen` sur `127.0.0.1` et `::1`, `SO_REUSEADDR`) ; pris par un autre programme : le suivant libre de la plage (en bouclant), jamais celui d'un autre worktree. Entre la sonde et l'écoute du runner, un autre programme peut le prendre (accepté).
- Relancer un runner terminé remplace son ancien processus dans `running`.
- `warnings` : textes en français, vide le plus souvent (aujourd'hui : `PORT` partagé avec un autre runner `dev` vivant du worktree).

**`runners.stop {id?, process_id}`** : `SIGTERM` au groupe de processus, `SIGKILL` au bout de 3 s s'il tourne encore ; réponse immédiate `{stopping: true, alive: true}` (déjà terminé : `{stopping: false, alive: false}`), la fin arrive par `runners.changed`. Un processus qui sort seul : `SIGHUP` aux restes de son groupe (comme une session), `SIGKILL` 3 s plus tard. Tests seulement : un binaire construit avec `test-support` lit `DEVMAESTRO_STOP_TIMEOUT_MS` (ce délai de 3 s, pour les sessions et les runners).

`id` (la session) est facultatif pour `runners.stop`, `runners.subscribe`, `runners.resize` ; donné, le processus doit appartenir à cette session (`-32026` sinon).

**Durée de vie** : un runner survit à la fermeture de l'app et à l'arrêt de sa session (sauf `sessions.stop {stop_runners: true}`) ; il s'arrête avec `sessions.forget` de sa session (retiré de la liste), avec `worktrees.remove` de son worktree (toutes sessions : `SIGTERM`, `SIGKILL` après 3 s, la suppression attend leur fin, 5 s au plus) et avec le démon (§ 9). Par session, au plus 8 vivants et 16 terminés gardés (les plus anciens partent).

**URL** : la sortie est lue par lignes (fin `\n` ou `\r`, 4 Kio au plus par ligne) après retrait des séquences ANSI (CSI, OSC dont les liens OSC 8, DCS…, même coupées entre deux lectures ; une séquence abandonnée par CAN ou SUB, ou plus longue que 4 Kio, est quittée et le texte reprend : une chaîne jamais terminée n'absorbe pas la suite). Sont repérés `localhost`, `127.0.0.1`, `[::1]` suivis de `:port` (1–65535), avec ou sans `http(s)://` (sans schéma : `http`), avec leur chemin ; `0.0.0.0` et `[::]` sont publiés en `127.0.0.1` et `[::1]`. Pas de chemin : `/`. Dédoublonnées, dans l'ordre d'apparition, 16 au plus, publiées dans `urls` (notification `runners.changed`).

Exemple : `{"id": "…", "runner_id": "package.json:dev", "expected_fingerprint": "9f2c…"}` → `{"process_id": "…", "runner_id": "package.json:dev", "session_id": "…", "label": "dev", "kind": "dev", "command": ["pnpm", "run", "dev"], "cwd": "", "port": 41372, "started_at": "…", "ended_at": null, "state": "running", "exit_code": null, "signal": null, "urls": [], "warnings": []}`.

### Changer de mode (`sessions.setMode`)

**Contournement** : Claude Code n'a pas d'API pour changer le mode d'une session en cours. Le démon écrit dans le PTY autant de Shift+Tab (`ESC [ Z`) qu'il en faut pour aller du mode courant connu (champ `mode` de la session : dernier `permission_mode` reçu dans un hook, ou dernier mode lu dans le pied de la TUI, voir plus bas) au mode visé, le long du cycle relevé avec **Claude Code 2.1.303** (prototype n° 1, Q9) : `default` (`manual`) → `acceptEdits` → `plan` → `auto` → `default`.

- Réponse `{sent: n}` (`0` si la session est déjà dans ce mode) une fois les touches mises en file.
- Erreurs : `-32014` si le mode courant est inconnu (ni hook ni pied ne l'a encore porté) ou hors du cycle (`bypassPermissions`, `dontAsk`…), ou si le mode visé est hors du cycle ; `-32002` si la session ne tourne pas, si une demande attend (Shift+Tab agirait sur le dialogue de la TUI), ou si le changement précédent n'est toujours pas confirmé (voir plus bas) ; `-32005` pour un mode dangereux sans réglage.

**Confirmation par le pied de la TUI** (seule lecture du PTY par le démon, § 2). Quand Claude est inactif, aucun hook ne vient confirmer un changement de mode : le démon lit donc, à chaque sortie du PTY, les 8 dernières lignes non vides de l'écran (`vt100`, texte sans mise en forme) et y cherche l'indicateur de mode de Claude Code, relevé avec **2.1.303** :

| Pied affiché | Mode |
|---|---|
| `⏸ manual mode on` | `default` |
| `⏵⏵ accept edits on (shift+tab to cycle)` | `acceptEdits` |
| `⏸ plan mode on (shift+tab to cycle)` | `plan` |
| `⏵⏵ auto mode on (shift+tab to cycle)` | `auto` |

- Seuls les mots comptent (`manual mode on`, `accept edits on`, `plan mode on`, `auto mode on`, sans tenir compte de la casse) : symboles et couleurs peuvent changer. Garde-fous :
  - avant les mots, au moins un **symbole de mode** de la famille lecture / pause (`⏸`, `⏵`, `⏩`, `⏯`, `▶`, `▷`, `▸`, `►`…) et rien d'autre : ni texte, ni `>`/`❯` (invite), `│`, `•`, `-`, `*`, `⏺` (puce des réponses de Claude) ;
  - après les mots, une fin de ligne, ou un blanc suivi de rien ou d'autre chose qu'une lettre ou un chiffre (`(shift+tab to cycle)`, indications alignées à droite ; pas « Plan mode on is now… ») ;
  - s'il y a une ligne de séparation du cadre de saisie (`────…` ou `╰───╯`, au moins 8 traits), seules les lignes **sous la dernière** sont lues ;
  - la ligne la plus basse l'emporte. Les modes dangereux ne sont jamais lus à l'écran (les hooks et `dangerous_mode_detected` s'en chargent).
- Un mode lu qui **change** met aussitôt à jour le `mode` de la session (`session.updated`, enregistré en base). Pendant un `setMode`, seul le mode visé est retenu (les modes traversés par plusieurs Shift+Tab sont ignorés), et il confirme le changement. Sans `setMode` en cours, tout mode lu est retenu (Shift+Tab tapé dans le terminal).
- **Les hooks font foi** : un hook qui porte un `permission_mode` remplace le mode lu à l'écran et clôt aussi un changement en cours (un hook qui rapporte un autre mode que celui visé est journalisé). Un hook qui change le mode fait aussi relire le pied à la sortie suivante du PTY.
- **Hook en retard** : un hook émis avant un Shift+Tab peut arriver après que le pied a montré le nouveau mode. Quand un hook contredit le mode lu à l'écran moins de 3 s plus tôt, le démon relit le pied 200 ms plus tard : s'il montre toujours ce mode, c'est lui qui est gardé (`session.updated`, avertissement au journal) ; sinon le hook l'emporte. Jamais pour un mode dangereux : un mode `bypassPermissions` ou `dontAsk` rapporté par un hook n'est jamais remplacé par une lecture de l'écran.
- Pied absent ou non reconnu (autre version de Claude Code) : rien n'est lu, le comportement est celui des hooks seuls.

**Second `setMode` pendant un changement non confirmé** : le démon réessaie de lui-même toutes les 25 ms pendant **1 s** au plus (le pied confirme en général bien avant), dans une tâche à part : les entrées et requêtes suivantes de ce client ne l'attendent pas (§ 3). Confirmé entre-temps : le calcul part du mode confirmé et la réponse est normale. Sinon `-32002`. Si l'écriture des Shift+Tab échoue (processus terminé), le changement est abandonné (`-32002`) et ne bloque pas le suivant. Un changement jamais confirmé (ni pied, ni hook) cesse de bloquer au bout de 3 s ; le calcul repart alors du dernier mode connu. Le cycle et le pied peuvent changer avec la version de Claude Code ou les modes disponibles.

## 5. Notifications du démon

| Méthode | Paramètres | Quand |
|---|---|---|
| `session.updated` | `{session: Session}` | à chaque changement : lancement, hook, statusline (si les mesures changent), mode lu dans le pied de la TUI, `sessions.update`, fin du processus, reprise |
| `session.effect` | `{id, effect: Effet}` | effets de la machine à états, juste **avant** le `session.updated` correspondant |
| `session.resync` | `{id, snapshot: Écran}` | un abonné a pris trop de retard (§ 6) |
| `quotas.updated` | `{profiles: {"<profil>": Quotas}}` | les quotas d'un profil ont changé (même forme que `quotas.get`) |
| `session.diff_changed` | `{id}` | la liste des fichiers changés ou leurs compteurs ont changé : relire `sessions.diff` (et le fichier affiché) |
| `session.removed` | `{id}` | la session a été oubliée (`sessions.forget`) : elle n'existe plus ; aucun `session.updated` ne suit pour elle |
| `project.worktrees_changed` | `{root}` | les worktrees du projet de racine `root` ont changé : création ou suppression par le démon (aussitôt), ou `dirty` / `integrated` (ou la liste) d'un worktree changé. Recalcul 2 s après la fin d'une session du dépôt, chaque `Stop` / `StopFailure` d'une session du dépôt, et toutes les 60 s pour les projets qui ont des sessions vivantes ou des worktrees non principaux au dernier calcul (au démarrage : ceux où le démon a créé un worktree) ; un seul calcul à la fois par projet (une demande pendant un calcul en relance un seul après). Le premier calcul d'un projet (ou un `worktrees.list`, s'il n'y a pas encore de référence) sert de référence sans notifier : le changement suivant est notifié. Relire `worktrees.list` |
| `conversation.changed` | `{id, upserts: [Entrée], segment_started?}` | des entrées de la conversation ont été ajoutées ou complétées (seulement pour les conversations lues par la connexion ; § 4, « Vue conversation ») |
| `runners.changed` | `{id, running: [RunnerProcess]}` | les processus de runners de la session `id` ont changé : lancement, URL repérée, fin, retrait (liste relue au moment d'envoyer, regroupée pour un client lent ; même forme que `running` de `runners.list`) |
| `runners.resync` | `{process_id, snapshot: Écran}` | un abonné à un runner a pris trop de retard (§ 6) |
| `forge.ci_changed` | `{id, state}` | l'état de la CI d'une session suivie (`forge.sessionCi`) a changé : `state` `"success"` \| `"failure"` \| `"pending"` \| `"none"` ; jamais au premier calcul ; suivi par un `session.updated` (`delivery`) (§ 4, « Livraison et suivi de CI ») |
| `session.subagents_changed` | `{id, agents: [Sous-agent sans report]}` | un sous-agent a été créé ou a changé de statut (ou d'un autre champ) ; compteurs d'outils : au plus une fois toutes les 500 ms par session (§ 4, « Sous-agents ») |

Pour un client lent, les `session.updated` en attente d'une même session sont **regroupés** : il reçoit l'état le plus récent au moment de l'envoi, pas chaque étape. Les `session.effect` ne sont pas regroupés ; si plus de 4 096 événements attendent (ou si le client a pris trop de retard sur le démon), la file est remplacée par un `session.removed` pour chacune des dernières sessions oubliées (jusqu'à 1 024, éventuellement déjà connues du client : à ignorer si l'`id` est inconnu) puis un `session.updated` par session, et les effets en trop sont perdus. Le dernier `session.updated` reçu fait toujours foi.

### Effet

```json
{"type": "notify_waiting", "request_id": 1, "pending": Demande}
{"type": "request_resolved", "request_id": 1, "how": "answered|answered_by_app|failed|denied|superseded|cleared"}
{"type": "clear_waiting"}
{"type": "possibly_stale", "request_ids": [1, 2]}
{"type": "dangerous_mode_detected", "mode": "bypassPermissions"}
{"type": "initial_prompt_sent"}
{"type": "initial_prompt_failed", "reason": "prompt initial abandonné : …"}
{"type": "resume_failed", "reason": "conversation_not_found", "message": "Claude Code n'a pas trouvé la conversation …"}
```

`resume_failed` : Claude Code a refusé la reprise (§ 4, « Reprise refusée par Claude Code ») ; même `reason` et `message` que le statut de la session.

`initial_prompt_sent` / `initial_prompt_failed` : envoi du prompt initial d'un `sessions.launch` avec `initial` (§ 4, « Forge »).

`dangerous_mode_detected` : un hook rapporte `bypassPermissions` ou `dontAsk` alors que le démon ne les autorise pas (Shift+Tab dans la TUI, réglage hors de portée du démon…). Le démon ne peut pas l'empêcher : il le signale (une fois par passage dans ce mode) et le journalise.

`notify_waiting` est le signal d'une notification desktop (lot 5). `request_id` est propre à la session.

## 6. Écran et flux d'un terminal

Le démon garde par session un émulateur sans affichage (`vt100`, 1 000 lignes d'historique) et un tampon des 2 derniers Mio d'octets bruts.

`sessions.subscribe` renvoie l'écran courant, puis le démon pousse des trames `0x02` pour cette session : exactement les octets arrivés **après** l'instantané, sans trou ni doublon (instantané et abonnement sont pris sous le même verrou ; la réponse précède toujours la première trame `0x02`).

```json
"snapshot": {
  "cols": 100, "rows": 30,
  "cursor": {"row": 12, "col": 2, "visible": true},
  "ansi": "…",
  "text": "…"
}
```

- `ansi` : séquences qui redessinent l'écran visible et rétablissent les modes d'entrée (collage encadré, touches de curseur applicatives, souris), à écrire dans un terminal de même taille ; écrire d'abord `ESC[0m ESC[2J ESC[H` dans un terminal déjà utilisé.
- `text` : le même écran sans mise en forme (lignes séparées par `\n`).
- `history` (si demandé par `history: true`) : le tampon d'octets bruts, coupé au début d'une ligne, en UTF-8 (caractères invalides remplacés). Il est pris sous le même verrou que l'instantané et l'abonnement : il s'arrête exactement où commencent les trames `0x02`, sans recouvrement. Pour retrouver l'historique défilé : écrire `history` puis `ansi` (l'écran visible est redessiné par-dessus).

Règles :

- Plusieurs trames de sortie peuvent être regroupées (jusqu'à 64 Kio).
- Un abonné lent ne bloque jamais le PTY ni les autres clients : au-delà de 1 024 morceaux de retard, les octets manquants sont abandonnés et le démon envoie `session.resync` avec un nouvel instantané ; le flux reprend juste après.
- Un nouvel abonnement à la même session sur la même connexion remplace le précédent (nouvel instantané).
- L'abonnement survit à l'arrêt et à la reprise de la session.
- `sessions.resize` redimensionne le PTY (le processus reçoit `SIGWINCH`) et l'émulateur. Avec plusieurs clients, la dernière taille demandée l'emporte.
- **Runners** (v0.3, lot 14a) : même mécanique, avec l'UUID du **processus** (`process_id`) dans les trames `0x02` et `0x03` ; `runners.subscribe` répond `{process_id, snapshot, history?}` (avec `cols`/`rows`, le terminal et le PTY sont d'abord redimensionnés) ; un abonné en retard reçoit `runners.resync {process_id, snapshot}`. Le terminal d'un runner terminé reste lisible tant que le processus est dans `running`. Une entrée pour un runner terminé est ignorée.
- Entrées : trames `0x03`, écrites dans l'ordre, **sans perte** : la file d'écriture d'une session est bornée (256 trames) ; quand elle est pleine, le démon cesse de lire la connexion qui écrit jusqu'à ce que `claude` ait consommé (contre-pression sur ce seul client : le PTY, les autres clients et les relais ne sont pas ralentis ; les requêtes de ce client attendent derrière ses entrées). Une entrée pour une session qui ne tourne pas est ignorée. Textes multi-lignes : les encadrer en *bracketed paste* (`ESC[200~ … ESC[201~`), voir architecture § 9.

## 7. Objets

### Session

```json
{
  "id": "uuid", "claude_session_id": "uuid",
  "title": "Refonte du relais" | null,  // titre donné par l'utilisateur (sessions.update)
  "color": "violet" | null,             // gris, bleu, vert, jaune, orange, rouge, violet, rose
  "display_name": "Refonte du relais",  // toujours un texte (§ 4, sessions.update)
  "first_prompt": "Corrige le test…" | null,
  "profile": "default", "cwd": "/…", "project_root": "/…", "branch": "main",
  "project_common_dir": "/…/.git" | null,  // identité du projet (dossier commun git, lot 6) : reste valable après la suppression du worktree
  "issue": {"number": 42, "title": "…", "url": "https://github.com/…/issues/42"} | null,  // issue liée au lancement (lot 13a, § 4 « Forge »)
  "model": "opus",                      // modèle demandé au lancement, ou null
  "mode": "default",                    // dernier mode connu (hooks, pied de la TUI), sinon celui demandé
  "status": {"state": "starting|running|waiting|idle|error|stopped",
             "wait": "permission|question",          // si waiting
             "reason": "prompt_input_exit",          // si stopped ; si error : "conversation_not_found" (reprise refusée, § 4)
             "message": "…"},                        // si error avec une raison : explication en français
  "pending": [{"request_id": 1, "answerable": true, "pending": Demande,
               "tool_use_id": "toolu_…", "agent_id": null, "since": "RFC 3339"}],
  "possibly_stale": false,
  "activity": {"kind": "idle|prompt|tool|subagents|compacting|waiting",
               "tool": "Bash",                       // si tool (ou l'outil de la demande, si waiting)
               "since": "RFC 3339" | null},          // début de cette activité
  "subagents_running": 1, "subagents_total": 3,   // sous-agents en cours / connus (§ 4)
  "metrics": {"model": {"id": "…", "display_name": "…"}, "cost_usd": 0.22,
              "context_used_pct": 3, "context_window_size": 1000000, "total_tokens": 26720,
              "rate_limits": {"five_hour": {"used_pct": 2, "resets_at": "RFC 3339"}, "seven_day": null},
              "session_name": "…"},
  "last_activity": "RFC 3339",          // dernier hook reçu
  "created_at": "RFC 3339", "updated_at": "RFC 3339",
  "alive": true, "pid": 1234,           // processus claude en cours
  "resumable": false,                   // ne tourne pas, a un transcript et son dossier (§ 4)
  "resume_blocker": null | "transcript_missing" | "cwd_missing",
  "scope": "devmaestro-session-1a2b3c4d-5e6f7a8b.scope" | null,   // scope systemd (§ 9)
  "last_exit": {"code": 0} | {"signal": "Hangup"} | null,
  "size": {"cols": 100, "rows": 30},
  "runners_running": 0,                 // runners vivants de la session (v0.3, lot 14a)
  "delivery": {"mode": "pr" | "trunk", "state": "none" | "pr_open" | "merged",   // v0.3, lot 14b ; null tant que
               "pull": {"number": 21, "url": "https://…"} | null,              // forge.sessionCi ne l'a pas calculé
               "ci": "success" | "failure" | "pending" | "none"} | null
}
```

`runners_running` change à chaque lancement ou fin d'un runner de la session (`session.updated`).

`delivery` (lot 14b) : dernier calcul de `forge.sessionCi` pour la session (mémoire seulement, perdu au redémarrage du démon) ; un changement de livraison ou de CI envoie un `session.updated`.

### Runner, RunnerProcess (v0.3, lot 14a)

```json
Runner: {
  "id": "app/package.json:dev",       // identifiant stable : la source
  "label": "dev",                      // nom du script, de la cible, de la recette, ou la commande (cargo, go, compose)
  "kind": "dev" | "test" | "build" | "lint" | "other",
  "command": ["pnpm", "run", "dev"],   // argv construit par le démon
  "cwd": "app",                        // relatif à la racine du worktree, "" pour la racine
  "source": "app/package.json:dev",    // fichier:clé
  "body": "Fichiers pris en compte (toute modification redemande la confirmation) :\n- app/package.json — 412 octets (source)\n…\n\nvite --host",
                                       // liste des fichiers pris en compte, puis l'extrait utile (4 Kio au plus)
  "body_truncated": false,
  "fingerprint": "9f2c…",              // SHA-256 à renvoyer dans runners.start (expected_fingerprint)
  "files": [                           // lot 15 : tous les fichiers qui font l'empreinte
    {"path": "app/package.json", "size": 412, "state": "ok", "note": "source"},
    {"path": "app/.npmrc", "size": null, "state": "absent", "note": "réglages du gestionnaire"},
    {"path": "../x.mk", "size": null, "state": "outside", "note": "inclus (include) ; sort de la racine"}
  ]
}
RunnerProcess: {
  "process_id": "uuid",                // identifiant de l'exécution (trames 0x02/0x03)
  "runner_id": "app/package.json:dev", "session_id": "uuid",
  "label": "dev", "kind": "dev", "command": ["pnpm", "run", "dev"], "cwd": "app",
  "port": 41372,                       // PORT du worktree
  "started_at": "RFC 3339", "ended_at": "RFC 3339" | null,
  "state": "running" | "exited",
  "exit_code": 0 | null,               // null tant qu'il tourne, ou tué par un signal
  "signal": "Terminated" | null,       // signal qui l'a tué
  "urls": ["http://localhost:41372/"]
}
```

Clés de `Runner.id` : nom du script / de la cible / de la recette ; `run`, `test`, `build`, `run:<membre>` (Cargo) ; `run`, `test`, `build` (Go) ; `up` (compose).

Tout champ peut être `null` quand la donnée est inconnue (principe 4).

`activity` (vue conversation, ADR 0005) : ce que fait Claude en ce moment, dérivé des seuls hooks (le transcript n'est écrit qu'à la fin de chaque message). `prompt` (« Claude écrit ») après `UserPromptSubmit` (prompt ou `task-notification`) et après chaque résultat d'outil (`PostToolUse`, `PostToolUseFailure`, `PermissionDenied`) ; `tool` (avec `tool`) au `PreToolUse` ; `subagents` quand le tour est fini (`Stop`, `StopFailure`, Échap, `Notification` `idle_prompt`, `SessionStart`) mais qu'un sous-agent tourne ou retient la session, sinon `idle` ; `compacting` de `PreCompact` à `SessionStart` `compact` (l'activité d'avant revient ensuite) ; une compaction annulée ou échouée en sort au prompt suivant ou à la fin du tour (`Stop`, `StopFailure`), et au plus tard 3 min après `PreCompact` ; `waiting` tant qu'une demande est ouverte (`since` : son arrivée). Les hooks d'un sous-agent ne la changent pas ; `SessionEnd` et la fin du processus : `idle`. `since` ne change que si le genre (ou l'outil) change. Diffusée par `session.updated`.

Raisons d'arrêt (`status.reason`) : celles de Claude Code (`prompt_input_exit`, `clear`, `logout`, `other`…) quand un `SessionEnd` est arrivé, sinon :

| Raison | Cas |
|---|---|
| `stopped_by_app` | arrêt demandé (`sessions.stop`, arrêt du démon) sans `SessionEnd` |
| `process_exit` | le processus est sorti seul, code 0, sans `SessionEnd` |
| `daemon_restart` | session active au moment où le démon a disparu (plantage) ; relue arrêtée au redémarrage |

Un processus sorti avec un code non nul ou tué par un signal inattendu, sans `SessionEnd`, donne `state: "error"` (sans `reason`, sauf `conversation_not_found` avec son `message` quand Claude Code n'a pas trouvé la conversation à reprendre, § 4). Toute session arrêtée ou en erreur est reprenable.

### Demande

```json
{"kind": "permission", "tool_name": "Bash", "tool_input": {…},
 "suggestions": [PermissionUpdate, …],     // permission_suggestions reçues, brutes
 "always_rules": [PermissionUpdate, …]}    // ce que « Toujours » enverra (vide : bouton indisponible)
{"kind": "question", "tool_name": "AskUserQuestion", "tool_input": {…},
 "questions": [{"question": "…", "header": "…", "multi_select": false,
                "options": [{"label": "…", "description": "…"}]}]}
{"kind": "permission" | "question", "detailed": false}     // connue seulement par une Notification
```

`answerable` (dans `pending`) : un relais `PermissionRequest` attend la décision ; l'app peut répondre.

`always_rules` : les `suggestions` de type `addRules`, de comportement `allow`, vers `session`, `localSettings` (`.claude/settings.local.json`) ou `projectSettings` (`.claude/settings.json`). Les autres sont écartées : changement de mode (« Toujours » ne fait jamais passer en `acceptEdits` ou `auto`), dossiers, règles `deny`/`ask`, et `userSettings` (`~/.claude/settings.json` : « Toujours pour ce projet » ne touche pas à la configuration de l'utilisateur). Exemple d'entrée : `{"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "npm test"}], "behavior": "allow", "destination": "localSettings"}`.

### Sous-agent

```json
{
  "agent_id": "aa98c9444728c5039",
  "agent_type": "general-purpose" | null,
  "description": "Première ligne README.md" | null,   // null si le rattachement au lancement est ambigu
  "model": "claude-opus-5-5" | null,                 // resolvedModel
  "tool_use_id": "toolu_…" | null,                   // appel à l'outil Agent
  "status": "running" | "done" | "failed" | "interrupted",
  "started_at": "RFC 3339", "ended_at": "RFC 3339" | null,
  "tool_count": 3, "current_tool": "Bash" | null, "last_tool": "Bash" | null,
  "report": "…" | null,              // seulement dans sessions.subagent
  "report_truncated": false,         // rapport coupé à 64 Kio
  "transcript_path": "…/subagents/agent-aa98c9444728c5039.jsonl" | null   // gardé, pas lu
}
```

- `done` : `SubagentStop` reçu ; `failed` : `task-notification` de statut `failed` (ou échec de l'outil `Agent`) ; `interrupted` : fin de la session (ou du processus, ou du démon) pendant qu'il tournait, `task-notification` `killed`, ou `Stop` dont `background_tasks` ne le liste plus sans `SubagentStop`. Un `SubagentStop` arrivé ensuite le fait passer `done`.
- `report` : `last_assistant_message` du `SubagentStop`, coupé à 64 Kio (sur une limite de caractère) avec `report_truncated: true`. C'est un texte de Claude, à afficher comme une donnée.
- Les `SubagentStop` d'agents internes de Claude Code (sans `SubagentStart`, `agent_type` vide) sont ignorés.

### Entrée de conversation

```json
{"uid": "71356630-…", "kind": "prompt", "ts": "RFC 3339" | null, "segment": 0,
 "agent_id": "a4138…",          // seulement pour une entrée lue dans le fichier d'un sous-agent
 "hidden_by_segment": true,     // seulement pour la commande /clear qui ouvre son segment
 …champs du genre}
```

- `uid` : `uuid` de la ligne du transcript qui a créé l'entrée (suffixe `#n` pour le n-ième bloc d'une même ligne ; `l<source>-<décalage>` pour une ligne sans `uuid`) ; stable, caractères `[A-Za-z0-9_.:#@-]`. `ts` : `timestamp` de cette ligne, tel quel. `segment` : numéro du segment.
- `prompt` : `{text, source: "typed" | "queued" | "suggestion" | "system" | "sdk", pasted: [{id, text}], prompt_id, truncated}`. Les collages `<pasted_content id="…">` sont extraits dans `pasted` et remplacés dans `text` par `[collage <id>]` (un collage court reste en ligne, comme dans la TUI). `source` : `promptSource` (`suggestion_accepted` → `suggestion`), `typed` s'il est absent ; le premier message d'un sous-agent est `system`. `prompt_id` : `promptId` du transcript (`null` s'il est absent).
- `text` : `{markdown, truncated}` — les blocs de texte successifs d'un même message d'API (`message.id`) ne font qu'une entrée, complétée quand un bloc arrive plus tard.
- `thinking` : `{}` — repère « Claude a réfléchi » (un par message ; contenu jamais gardé).
- `tool` : `{tool_use_id, name, summary, input, input_truncated, result?: {status: "ok" | "error" | "interrupted", text, truncated, patch?}}`. `summary` : une ligne (200 caractères au plus : chemin, commande, motif, URL, requête…). `result` absent tant que le résultat n'est pas arrivé. `patch` (`Edit`, `Write`…) : hunks de `structuredPatch` à la forme de `sessions.diffFile` : `[{header, old_start, old_lines, new_start, new_lines, lines: [{kind: " " | "+" | "-", old_no, new_no, text}]}]` (absent au-delà de 64 Kio).
- `question` : `{tool_use_id, questions, answers}` — `questions` : celles d'`AskUserQuestion` (forme de Claude Code) ; `answers` : `{"<question>": "<réponse>"}` une fois répondue, sinon `null`.
- `subagent` : `{tool_use_id, agent_id, agent_type, description, status: "running" | "done" | "failed" | "interrupted"}` — appel de l'outil `Agent` (ou `Task`). Son `agent_id` est celui de l'agent **lancé** (`null` tant qu'il n'est pas connu) ; elle se range dans le fil de son parent (un sous-agent lancé par un sous-agent porte en plus `parent_agent_id`, l'agent dont le fichier la porte). Les entrées de l'agent lancé se lisent par `conversation.subagent`. `status` : `running` jusqu'au résultat (`async_launched` : toujours `running`), `done`, `failed` ou `interrupted` selon le résultat, puis la `task-notification` de même `tool-use-id` (`completed` → `done`, `failed` → `failed`, autre → `interrupted`).
- `notification` : `{task_id, status, summary, truncated}` — fin d'une tâche de fond (`<task-notification>` injectée par Claude Code) : un événement, pas un prompt.
- `compaction` : `{trigger: "manual" | "auto", pre_tokens, post_tokens, summary, truncated}` — séparateur de `/compact` ; `summary` arrive par un `upsert` (`null` avant). Claude Code écrit le séparateur **avant** la commande `/compact` qui l'a déclenché : le démon range la commande juste devant lui (les `uid` ne changent pas ; la compaction reprend une révision, les deux partent dans le même `conversation.changed`, dans l'ordre du fil). Un client qui garde ses entrées dans l'ordre de leur arrivée place une entrée nouvelle là où la notification la met, avant une entrée déjà connue qui la suit.
- `command` : `{name, args, output, truncated}` — commande locale (`/compact`, `/clear`, `/model`…), sortie sans codes ANSI, complétée par un `upsert` ; mode bash de la TUI : `name: "!"`. La commande `/clear` qui ouvre un segment (première entrée de ce segment) porte `hidden_by_segment: true` : le séparateur de segment la montre déjà, le front ne l'affiche pas en plus (elle reste dans la liste, pour la pagination). Le champ est absent ailleurs.
- `error` : `{message, truncated}` — erreur d'API (`system/api_error`, message d'erreur de l'API) ou interruption (`[Request interrupted by user…]`).
- `unknown` : `{type, subtype}` — type de ligne, sous-type de `system` ou bloc d'`assistant` inconnu : à afficher en repli.

Ignorés (intendance) : pièces jointes, lignes `isMeta`, `<system-reminder>`, `<local-command-caveat>`, types `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-*`, `api-request*`, `cost-state`, `queue-operation`…, sous-types `stop_hook_summary`, `turn_duration`…, la ligne nue `/compact` qui précède sa `command`. Liste dans `crates/core/src/domain/conversation.rs`.

### Profil, ancienne session

```json
{"name": "work", "config_dir": "/home/u/.claude-work", "sets_config_dir_env": true}
{"claude_session_id": "…", "transcript_path": "…", "cwd": "…", "resume_cwd_inferred": true, "git_branch": "…",
 "first_prompt": "…", "title": "…", "display_name": "…",
 "first_timestamp": "…", "last_timestamp": "…", "last_activity": "…", "message_count": 12,
 "hidden": false}
```

Entrée de `transcripts.list` (ancienne session) :

| Champ | Type | Contenu |
|---|---|---|
| `claude_session_id` | texte | nom du fichier quand c'est un UUID, sinon `sessionId` lu dans le transcript |
| `transcript_path` | texte | chemin absolu du fichier `.jsonl` |
| `cwd` | texte absolu \| `null` | dossier de reprise (§ 4) : le premier `cwd` du transcript dont l'encodage de Claude Code est le nom du dossier qui contient le transcript et qui existe ; à défaut, `cwd` de la première ligne qui en porte un (`null` s'il n'y en a pas ou s'il n'est pas absolu ; le nom du dossier n'est jamais décodé). Dossier par défaut de `sessions.resume` ; de quoi regrouper par dossier, et par dépôt avec `projects.resolve` |
| `resume_cwd_inferred` | booléen | `cwd` est le dossier retrouvé par l'encodage ; `false` : règle de repli (premier `cwd` lu), Claude Code ne trouvera sans doute pas la conversation depuis ce dossier |
| `git_branch` | texte \| `null` | branche de la dernière ligne lue qui en porte une |
| `first_prompt` | texte \| `null` | premier prompt tapé, coupé à 200 caractères |
| `title` | texte \| `null` | titre donné par Claude Code (`aiTitle` ou `summary`) |
| `display_name` | texte | nom à afficher (§ 4) |
| `first_timestamp`, `last_timestamp` | RFC 3339 \| `null` | premier et dernier horodatage lus |
| `last_activity` | RFC 3339 \| `null` | dernière activité : `last_timestamp`, sinon date de modification du fichier |
| `message_count` | entier \| `null` | lignes `user` et `assistant` (hors sous-agents) ; `null` pour un gros fichier lu par le début et la fin |
| `hidden` | booléen | masquée (`sessions.forget` ou `transcripts.hide`) ; `true` seulement avec `include_hidden` |
| `cwd_exists` | booléen | `cwd` connu, absolu, et le dossier existe (sinon une reprise renverra `-32016`) |

Liste triée par date de modification du fichier, de la plus récente à la plus ancienne.

## 8. Relais (`orchd hook`, `orchd statusline`)

Lancés par Claude Code, avec l'environnement du processus `claude` :

| Variable | Valeur |
|---|---|
| `ORCH_SOCKET` | chemin du socket **des relais** (`relay.sock`) ; celui de contrôle n'est jamais passé |
| `ORCH_TOKEN` | jeton de 16 octets tirés du générateur aléatoire du système (`getrandom`), en hexadécimal (32 caractères), propre au processus `claude` en cours ; renouvelé à chaque reprise |
| `ORCH_SESSION` | identifiant interne de la session (information, jamais utilisé pour authentifier) |

Toute autre variable `ORCH_*` ou `DEVMAESTRO_*` héritée du démon est retirée de l'environnement de `claude`.

**Marqueurs de session Claude Code** : un démon lancé depuis une session Claude Code (app lancée depuis un terminal d'une session, par exemple) hérite des variables que Claude Code pose pour **ses** sous-processus. Transmises, elles font passer nos `claude` pour des sessions enfants : `CLAUDE_CODE_CHILD_SESSION` coupe l'enregistrement du transcript (« Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker ») et exclut la session de `--resume`. Le démon les retire **de son propre environnement au démarrage** (noms écrits au journal, jamais les valeurs ; ses sous-processus `git`, `systemd-run`… ne les voient donc pas) **et** de celui de chaque `claude` (code : `CLAUDE_SESSION_MARKERS` dans `daemon/launch.rs`) :

| Retirées | Pourquoi |
|---|---|
| `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` | « je tourne sous Claude Code » (documentées comme posées dans les sous-processus) |
| `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH` | point d'entrée et binaire de la session parente |
| `CLAUDE_CODE_SSE_PORT` | port de l'extension IDE de la session parente |
| `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID` | identifiants et contexte (Remote Control, session cloud) de la session parente |
| `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` | boîte de réception (et son jeton) de la session parente |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` | posée par une plateforme qui embarque Claude Code, pour son processus |
| `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_JOB_DIR` | pid, effort et dossier de tâche de la session parente |
| `TRACEPARENT` | contexte de trace propagé par la session parente |
| `AI_AGENT` | posée par Claude Code pour son outil Bash (« lancé par un agent ») |
| `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | réglages documentés, mais hérités de l'hôte ils connecteraient toutes les sessions au même compte, quel que soit le profil : le profil (`CLAUDE_CONFIG_DIR`) est la seule source de compte |
| `CLAUDE_CODE_SIMPLE` | réglage documenté (mode dépouillé) qui risque de désactiver les hooks et le plugin dont dépend le suivi |
| préfixes `CLAUDE_CODE_SESSION_*`, `CLAUDE_CODE_PARENT_*` | identifiant et état de la session parente (`CLAUDE_CODE_SESSION_ID`, `…_ATTENDED`…) |
| préfixe `CLAUDE_CODE_SDK_*` | posées par un hôte Agent SDK (app de bureau…) pour son processus (rafraîchissement de l'authentification par l'hôte…) |
| préfixes `CLAUDE_AGENT_SDK_*`, `CLAUDE_CODE_DESKTOP_*`, `CLAUDE_PREVIEW_*` | posées par l'app de bureau Claude (Claude Desktop) et son Agent SDK pour **leur** session : version du SDK et de l'app, nommage des outils MCP, réglages de préversion (relevé en vrai : app DevMaestro lancée depuis une session Claude Desktop) |
| `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_ORGANIZATION_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_OAUTH_SCOPES` | compte et organisation de l'hôte Claude Desktop : ils pourraient contredire le profil (le profil est la seule source de compte) |
| `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, `CLAUDE_CODE_EAGER_FLUSH`, `CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES`, `CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_REPORT_FINDINGS`, `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`, `CLAUDE_CODE_TERMINAL_MCP_TOOLS` | réglages de comportement posés par l'hôte Claude Desktop pour sa session, pas par l'utilisateur |

Les préfixes gardent leur `_` final : `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` est un réglage. Les autres `CLAUDE_CODE_*` (réglages que l'utilisateur peut poser dans son shell) sont gardés. Les variables de **configuration** documentées sont transmises telles quelles (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `ANTHROPIC_*`, mandataires `HTTP(S)_PROXY`, clés d'API…). Le `claude` lancé pose ensuite ses propres marqueurs pour ses hooks et sa statusline (dont nos relais), comme d'habitude.

Le démon rattache une trame à sa session **par le jeton** (comparé en temps constant), jamais par le `session_id` du JSON (qui change sur `/clear`). Jeton inconnu (session terminée, faux jeton) : trame ignorée.

- **`orchd hook <événement>`** (sauf `PermissionRequest`) lit stdin, envoie une trame `0x10`, attend l'accusé `0x12` (envoyé une fois l'événement appliqué : les hooks d'une session sont traités dans l'ordre où Claude Code les lance), puis sort. Budget total : 1 s, 0,5 s pour `SessionEnd` (qui partage 1,5 s avec les hooks de fin de l'utilisateur). Il n'écrit **jamais** rien et sort **toujours** en 0 : démon absent, variable manquante, JSON illisible, délai dépassé, tout est silencieux.
- **`orchd hook PermissionRequest --wait <s>`** (relais bloquant, ADR 0003) :
  1. envoie la trame `0x10` et garde la connexion ouverte ;
  2. le démon applique l'événement, puis rattache le relais à la demande créée ou retrouvée (même demande déjà connue : il s'y ajoute) ; la demande passe `answerable: true` ;
  3. réponse de l'app → trame `0x13` : le relais écrit ce JSON (suivi d'un saut de ligne) sur sa sortie standard, puis sort en 0. Forme : `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow" | "deny", …}}}` (§ 4) ;
  4. libération **sans décision** → trame `0x12`, rien n'est écrit, sortie en 0 : demande close par un autre chemin (`PostToolUse` après une réponse dans la TUI, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd` ; une demande d'un sous-agent qui tourne encore survit à `Stop`, `StopFailure` et `UserPromptSubmit`), processus `claude` terminé, session arrêtée, arrêt du démon (les relais sont libérés dès le début de l'arrêt), ou trame que le démon ne peut rattacher (jeton inconnu, JSON illisible, session arrêtée) ;
  5. délai `--wait` dépassé ou démon disparu (fin de connexion) : rien n'est écrit, sortie en 0. Le démon voit la connexion se fermer et détache le relais (`answerable: false`) ; la demande reste affichée (la TUI la montre toujours).

  Le relais n'autorise **jamais** rien de lui-même. Le `timeout` du hook est écrit dans `hooks.json` (600 s, le défaut de Claude Code) et `--wait` vaut ce délai moins une marge (5 s ; un quart du délai, au moins 1 s, pour un délai court) : le relais rend la main avant que Claude Code ne le tue. La variable `DEVMAESTRO_PERMISSION_TIMEOUT_SECS` du **démon** (2 à 3600) change ce délai, pour les tests ; elle n'est jamais transmise à `claude`.
- **`orchd statusline --config-dir <dossier du profil>`** envoie une trame `0x11` et attend l'accusé `0x12` (300 ms au plus, en parallèle de la suite : le démon vérifie que l'expéditeur, encore vivant, est un processus de la session), lance la statusline de l'utilisateur (`statusLine.command` de `<dossier>/settings.json`, par `sh -c` dans son propre groupe de processus, même stdin) et affiche sa sortie. Au bout de 2 s (commande trop lente, ou descendant en arrière-plan qui garde la sortie ouverte), tout le groupe est tué et le relais affiche ce qui a été écrit jusque-là ; à défaut, une ligne `DevMaestro · contexte 3 % · 0,22 $`. La variable `DEVMAESTRO_STATUSLINE_CHAINED` posée pour la statusline de l'utilisateur empêche une boucle.

Fichiers générés (au démarrage du démon et avant chaque lancement) :

- `$XDG_DATA_HOME/devmaestro/claude-plugin/` : `.claude-plugin/plugin.json` et `hooks/hooks.json`, où chaque événement (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`) appelle `<orchd> hook <événement>` en forme exec (`command` + `args`) ; matcher `*` pour les événements d'outil ; `PermissionRequest` porte en plus `"timeout": 600` et `args: ["hook", "PermissionRequest", "--wait", "595"]` ;
- `$XDG_DATA_HOME/devmaestro/settings/<profil>.json` : `{"statusLine": {"type": "command", "command": "'<orchd>' statusline --config-dir '<dossier>'"}}`, plus `"permissions": {"disableBypassPermissionsMode": "disable"}` quand `allow_dangerous_modes` est faux (Claude Code refuse alors d'entrer en `bypassPermissions` ; ce verrou applique la valeur la plus stricte de toutes les sources). Il n'existe pas de verrou équivalent pour `dontAsk` (qui refuse, au lieu d'autoriser, tout ce qui demanderait une permission).

## 9. Cycle de vie et persistance

- **Scope systemd** : si `systemd-run --user --scope` fonctionne au démarrage du démon (gestionnaire systemd utilisateur joignable ; désactivable par `DEVMAESTRO_SYSTEMD_SCOPE=off`), chaque lancement devient `systemd-run --user --scope --quiet --collect --unit=devmaestro-session-<id8>-<alea8>.scope -- claude …` : `systemd-run` s'inscrit dans le scope puis exécute `claude` à sa place (même pid, même PTY, même environnement et dossier). Sinon, lancement direct. Le mode est écrit au journal au démarrage et dans `Session.scope`. Pour les tests seulement, `DEVMAESTRO_SYSTEMD_RUNTIME_DIR` donne à `systemd-run` le vrai `XDG_RUNTIME_DIR` quand celui du démon est temporaire.
- Lancement : `claude (--session-id <uuid> | --resume <id>) [--permission-mode <mode>] [--model <m>] --plugin-dir <plugin> --settings <réglages du profil> [-- "<prompt>"]` dans un PTY, `cwd` = le dossier demandé, avec `TERM=xterm-256color`, `COLORTERM=truecolor`, les variables du § 8 (marqueurs de session Claude Code hérités retirés), et `CLAUDE_CONFIG_DIR` pour les profils autres que `default` (retiré de l'environnement hérité pour `default`). Le mode `default` s'écrit `manual` sur la ligne de commande. Le binaire vient de `DEVMAESTRO_CLAUDE_BIN`, sinon du `PATH` du démon. Le prompt suit `--` (fin des options façon commander.js, d'après `claude --help`) : un prompt comme `--dangerously-skip-permissions` ou `- liste` n'est pas lu comme une option. **À vérifier avec le vrai CLI** : que `--` est accepté et qu'un prompt égal au nom d'une sous-commande (`mcp`, `update`…) n'est pas lancé comme telle.
- À la fin du processus `claude`, son groupe de processus reçoit `SIGHUP` (outils restés en arrière-plan), comme à la fermeture d'un terminal.
- Les sessions sont enregistrées dans `$XDG_DATA_HOME/devmaestro/state.db` (SQLite, WAL, `synchronous=NORMAL`) : identifiants, profil, dossiers, branche, modèle, mode, statut, dates, pid, (schéma v2) date de démarrage du processus et scope systemd, (schéma v3) titre, couleur, premier prompt et dernier `session_name` de la statusline, (schéma v4) la table `hidden_transcripts (profile, claude_session_id, hidden_at)` des transcripts masqués, (schéma v6) la colonne `project_common_dir` des sessions et la table `worktrees (path, common_dir, project_root, branch, base, created_branch, start_sha, created_at)` des worktrees créés par le démon (ligne retirée par `worktrees.remove` ou à l'annulation d'une création), (schéma v7) les colonnes `issue_number`, `issue_title`, `issue_url` des sessions (issue liée au lancement, § 4 « Forge » ; une ligne incomplète ou invalide est relue sans issue), et (schéma v5) la table `subagents` (clé `(session, agent_id)`, ordre de lancement `seq`, champs de l'objet `Sous-agent` dont le rapport) : au plus les **100** derniers par session, écrits à chaque création ou changement de statut ou de champ ; les **compteurs d'outils** (`tool_count`, `current_tool`, `last_tool`) ne sont écrits qu'avec ces changements (après un plantage du démon, ils peuvent donc être en retard). Le plafond suit la même règle en mémoire et en base : les plus anciens finis partent d'abord, jamais un `running` ; un sous-agent oublié en mémoire est retiré de la base. Supprimés avec la session (`sessions.forget`). Au démarrage du démon, les sous-agents restés `running` sont relus `interrupted`, avec `ended_at` = dernière activité de la session (ou l'instant de la relecture). Au redémarrage après un plantage, les processus `claude` relus dont des processus vivent encore (eux-mêmes, ou d'autres dans leur groupe ou leur session) restent refusés au socket de contrôle (§ 10). Écriture à chaque changement de statut ou de champ ; une session qui ne change que par sa dernière activité est réécrite au plus toutes les 30 s. Le schéma est versionné (`PRAGMA user_version`, migrations pas à pas) : une base d'une version plus récente est refusée (le démon ne démarre pas, message en français) ; une base illisible ou corrompue est renommée `state.db.corrupt-<horodatage>` et remplacée par une base vide (avertissement au journal).
- Droits : dossiers `$XDG_RUNTIME_DIR/devmaestro`, `$XDG_DATA_HOME/devmaestro` et `$XDG_STATE_HOME/devmaestro` en 0700 (refusés s'ils sont un lien symbolique ou appartiennent à un autre utilisateur), base, journal, plugin et réglages en 0600.
- **Arrêter le démon termine les sessions** : `SIGTERM`, `SIGINT` ou `SIGHUP` → `SIGHUP` à chaque session (le socket reste ouvert pour recevoir les `SessionEnd`), `SIGKILL` au bout de 3 s, puis fin. Un second signal pendant cet arrêt envoie `SIGKILL` à toutes les sessions et sort aussitôt. Les sessions restent reprenables. Après un plantage du démon, les sessions qui étaient en démarrage, en cours, à répondre ou inactives sont relues arrêtées (`daemon_restart`) ; celles déjà arrêtées ou en erreur sont relues telles quelles (statut et date inchangés).
- **Runners** (v0.3, lot 14a) : **non persistés**. Leurs processus ne survivent pas au démon (arrêt : `SIGTERM` à chaque runner avec le `SIGHUP` des sessions, puis `SIGKILL` après 3 s ; plantage : la fermeture de leur PTY leur envoie `SIGHUP`) : un démon qui redémarre n'a aucun runner, `running` est vide. Le port d'un worktree, dérivé de son chemin, reste en général le même. Limite : un runner qui ignore `SIGHUP` survit à un plantage du démon, hors de toute liste ; avec un scope systemd, ses processus restent refusés au socket de contrôle (§ 10).
- Journal : sortie d'erreur et `$XDG_STATE_HOME/devmaestro/orchd.log`.
- Réglages du démon (facultatifs, jamais écrits par lui) : `$XDG_CONFIG_HOME/devmaestro/config.toml` (repli `~/.config/devmaestro/config.toml`), lu **une fois au démarrage** : un changement demande de redémarrer le démon (l'app le fera après avoir changé le réglage). Clés : `allow_dangerous_modes = true | false` (faux par défaut) : autorise `bypassPermissions` et `dontAsk` au lancement, à la reprise et par `sessions.setMode` ; et `[quotas]` `usage_api = true | false` (vrai par défaut) : interroger l'API d'usage de Claude Code (non documentée, voir « Quotas » ci-dessous), `false` pour ne lire les quotas que dans les statuslines. Fichier absent, illisible ou invalide : valeurs par défaut (avertissement au journal). L'app l'exposera plus tard comme un réglage explicite.

### Quotas (`quotas.get`, `quotas.updated`)

Par profil, deux sources ; **chaque fenêtre** (`five_hour`, `seven_day`) garde sa lecture non nulle la plus récente, quelle qu'en soit la source :

- les `rate_limits` des statuslines des sessions de ce profil (souvent absents des versions récentes de Claude Code) ;
- l'**API d'usage** de Claude Code, `GET https://api.anthropic.com/api/oauth/usage` (non documentée ; en-têtes `Authorization: Bearer <jeton OAuth>` et `anthropic-beta: oauth-2025-04-20`, aucune redirection suivie, **aucun mandataire** : `HTTP(S)_PROXY` sont ignorés pour cet appel, le jeton va directement à l'hôte de l'API ; 10 s au plus), interrogée au démarrage du démon, toutes les 5 min et sur `quotas.get {refresh: true}`. Une **tournée** interroge tous les profils en parallèle, dans une tâche détachée, en 15 s au plus (un appel plus lent finit en arrière-plan) ; une seule tournée à la fois (une demande pendant une tournée est sans effet) ; pour un même profil, au moins **10 s** entre deux essais (une demande plus tôt ne rappelle pas l'API). Le jeton est lu à chaque appel, en lecture seule, dans `<dossier du profil>/.credentials.json` (`claudeAiOauth.accessToken`). Expiré (`expiresAt` passé) : aucun appel, erreur « jeton expiré : Claude Code le renouvellera à sa prochaine requête » ; DevMaestro ne le renouvelle jamais. Un appel qui échoue garde la lecture précédente et pose `error`.

`quotas.get {refresh?: bool}` répond **tout de suite** avec les quotas connus ; `refresh` vrai lance en plus une tournée, dont les résultats arrivent par `quotas.updated` (autre type que booléen : `-32602`). Même forme pour `quotas.updated` :

```json
{"profiles": {
  "default": {
    "five_hour": {"used_percentage": 12.0, "resets_at": "2026-10-20T13:00:00.123456Z",
                  "source": "usage_api", "fetched_at": "RFC 3339"} | null,
    "seven_day": {"used_percentage": 35.5, "resets_at": "2026-10-24T08:00:00Z",
                  "source": "statusline", "fetched_at": "RFC 3339"} | null,
    "source": "usage_api" | "statusline" | null,
    "fetched_at": "RFC 3339" | null,
    "error": "jeton expiré : …" | null
  },
  "work": {"five_hour": null, "seven_day": null, "source": null, "fetched_at": null,
           "error": "aucun jeton OAuth : Claude Code n'est pas connecté avec ce profil"}
}}
```

- Par fenêtre : `used_percentage`, `resets_at` (`null` si inconnue), et la `source` et la date (`fetched_at`) de **sa** lecture. Une fenêtre dont la remise à zéro est passée devient `null` ; une lecture de statusline sans `resets_at` est montrée 6 h au plus.
- `source`, `fetched_at` au premier niveau : ceux de la lecture la plus récente toutes fenêtres confondues (compatibilité). `error` : celle du dernier appel à l'API (toujours `null` avec `usage_api = false`), même si une lecture plus ancienne est affichée.
- `resets_at` lu dans la réponse de l'API : texte RFC 3339, ou nombre de secondes (de millisecondes au-delà de 10¹¹) depuis 1970.
- Tous les profils de `profiles.list` sont présents. `quotas.updated` n'est envoyé que si ce JSON change (regroupé pour un client lent).
- Erreurs possibles (texte en français, jamais le jeton) : aucun jeton OAuth, identifiants illisibles, jeton expiré, jeton refusé (HTTP 401/403), réponse inattendue (HTTP n), API injoignable, réponse illisible. Une erreur nouvelle est journalisée une fois.
- Tests seulement : un binaire construit avec la fonctionnalité `test-support` lit `DEVMAESTRO_USAGE_API_URL` (serveur local) et `DEVMAESTRO_QUOTA_MIN_INTERVAL_MS` (intervalle minimal) ; le binaire distribué les ignore.

## 10. Modèle de menace

**Frontière de confiance : l'utilisateur.** Le démon, l'app, `claude` et tout ce que `claude` exécute tournent sous le même uid. Les droits (`0700` / `0600`) protègent des **autres** utilisateurs ; ils n'arrêtent pas un processus de l'utilisateur.

### Ce qui est protégé (défense en profondeur)

**Une session ne pilote pas le démon.** Un processus `claude` supervisé, et tout ce qu'il lance (une commande Bash détournée par une injection de prompt, par exemple), ne doit pas pouvoir lancer une session en `bypassPermissions`, taper dans une autre session, ni approuver ses propres demandes (`sessions.answerPermission`).

- **Deux sockets** : `claude` ne reçoit que le chemin de `relay.sock`, qui n'accepte que des trames de hook et de statusline.
- **Socket de contrôle, pair refusé** (contrôles faits à chaque connexion, dans l'ordre) :
  1. uid différent de celui du démon, ou pair non identifiable (`SO_PEERCRED`) ;
  2. pair dans un **scope systemd de session ou de runner** (`/proc/<pid>/cgroup` contient `devmaestro-session-…scope` ou `devmaestro-runner-…scope`). L'appartenance à un cgroup survit à `setsid`, aux doubles forks et au rattachement à `init` : en sortir demande un appel **délibéré** à `systemd-run` (ou l'écriture dans un autre cgroup de l'utilisateur). Seulement quand les sessions sont lancées dans un scope (§ 9) ;
  3. `ORCH_TOKEN=` ou `ORCH_SESSION=` dans l'environnement du pair (`/proc/<pid>/environ`) : un descendant qui n'a pas nettoyé son environnement. Un environnement illisible ne fait pas refuser (un processus peut aussi simplement retirer ces variables) ;
  4. pair = processus `claude` supervisé, actuel, passé, ou relu en base après un plantage du démon, ou l'un de ses descendants : chaîne des parents remontée dans `/proc`, et à chaque étape groupe et session comparés à ceux des sessions (lancées par `setsid` : pid = groupe = session). Les processus supervisés sont identifiés par leur date de démarrage : un pid réattribué depuis ne fait pas refuser un client légitime ; une date inconnue ne correspond à rien. Un processus supervisé disparu, dont plus aucun processus ne vit dans son groupe ni sa session, est oublié.
  
  Le pair est épinglé par `SO_PEERPIDFD` (noyau 6.5 et plus) : après les lectures de `/proc`, le démon vérifie que ce processus vit toujours (son pid n'a donc pas été réattribué entre l'acceptation et la fin des contrôles). Sans pidfd, la date de démarrage du pid est relue et comparée.
- **Socket des relais** : une trame n'est acceptée que si son jeton désigne une session vivante **et** si le pair descend du processus `claude` de cette session (ou partage son scope systemd). Un processus d'une session ne peut donc rien envoyer pour une **autre** session. En revanche, un processus d'une session connaît le jeton de **sa** session et peut forger des événements pour elle (une fausse demande, une fausse fin de tour) : l'app affiche toujours le contenu exact de la demande, et « Toujours » ne reprend que les suggestions de la **première** trame d'une demande, seulement des règles qui correspondent à l'outil et à l'entrée de la demande (`toolName` égal ; pour `Bash`, `ruleContent` obligatoire, égal à la commande ou préfixe `…:*` qu'elle prolonge ; pour les outils de fichiers, `ruleContent` obligatoire, égal au chemin ou `<dossier absolu>/**` qui le contient).
- **Runners** (v0.3, lot 14a) : du code du dépôt, aussi peu sûr qu'une commande Bash d'une session. Le démon n'exécute que les commandes construites par sa propre détection (jamais une commande venue de l'interface, `-32024`), sans shell ; leur processus est supervisé comme `claude` (ses descendants sont refusés au socket de contrôle) et lancé dans son propre scope `devmaestro-runner-…scope` (refusé lui aussi) ; il ne reçoit ni `ORCH_*` ni le chemin d'un socket. Lancer un runner exécute du code du dépôt sur la machine : l'app demande une confirmation la première fois par worktree.
- **Environnement de `claude`** : les variables `ORCH_*` et `DEVMAESTRO_*` héritées sont retirées, ainsi que les marqueurs de session Claude Code (§ 8), dont le jeton de messagerie d'une session parente (`CLAUDE_CODE_MESSAGING_TOKEN`).
- **Modes qui suppriment les demandes** (`bypassPermissions`, `dontAsk`) : réglage explicite du démon (§ 9), y compris quand ils viennent d'un `defaultMode` du projet ou du profil ; `bypassPermissions` verrouillé dans les réglages passés à `claude` ; passage détecté et signalé (`dangerous_mode_detected`).
- **Transcripts** (vue conversation) : le démon ne lit que ceux des sessions qu'il connaît, résolus sous `<dossier du profil>/projects/` ; leur contenu ne va qu'aux clients du socket de contrôle et n'est jamais journalisé (§ 4, « Vue conversation »).
- **Le relais n'autorise jamais rien par défaut** (délai, démon absent : sortie sans décision).

- **Forge (`gh`)** : le démon lance la CLI `gh` de l'utilisateur, à la demande d'un client (méthodes `forge.*`), en lecture seule sauf `forge.submitReview` (publication d'une revue, à l'initiative explicite de l'utilisateur dans l'app, servie seulement sur le socket de contrôle, § 4 « Forge : demandes de fusion ») ; c'est `gh` qui va sur le réseau, avec la connexion et le mandataire de l'utilisateur. Le démon ne lit, ne transmet ni ne journalise aucun jeton : les variables `GH_*` / `GITHUB_*` héritées (jetons, hôte, dépôt) sont retirées de l'environnement de `gh` (sauf `GH_CONFIG_DIR`), aucune option `--show-token` n'est passée, et les messages de `gh` sont nettoyés (jetons masqués, chemins retirés) avant d'aller au client. Le contenu des issues et des demandes de fusion (dont les revues publiées) et les journaux de CI ne sont ni journalisés ni écrits en base (§ 4, « Forge ») ; un journal de CI collé à Claude est nettoyé, ses secrets apparents masqués et borné (§ 4, « Livraison et suivi de CI »). Désactivable par le réglage « Accès aux forges » de l'app.
- **Identifiants Claude Code et réseau** : le démon lit (jamais n'écrit) le jeton OAuth de chaque profil (`.credentials.json`) pour l'API d'usage ; il ne l'envoie qu'à `https://api.anthropic.com/api/oauth/usage` en HTTPS (TLS rustls, sans suivre de redirection ni passer par un mandataire), ne le journalise pas et ne le renvoie à aucun client. C'est la seule connexion que le démon ouvre lui-même (`gh`, voir ci-dessus, ouvre les siennes) ; elle se coupe par `[quotas] usage_api = false` (§ 9). Aucun port n'est ouvert.

### Ce qui n'est pas protégé (atténuation, pas un bac à sable)

- **Sans scope systemd** (pas de gestionnaire utilisateur) : un processus qui crée sa propre session (`setsid -f`) **et** nettoie son environnement n'est plus reconnu (constaté par les tests). Avec un scope, il faut en plus en sortir délibérément.
- Un processus de l'utilisateur peut lire ses fichiers et, selon `ptrace_scope`, la mémoire de ses autres processus (dont le démon et l'app), ou écrire dans ses autres cgroups.
- Un processus lancé par l'utilisateur **depuis** une session (par exemple l'app de développement lancée dans un terminal d'une session DevMaestro) est refusé sur le socket de contrôle : la lancer hors des sessions.
- `orchd ctl` passe par le socket de contrôle comme le front : il fonctionne depuis un terminal ordinaire, pas depuis une session supervisée.
