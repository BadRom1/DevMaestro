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
| `-32016` | `sessions.resume` impossible : le dossier de travail n'existe plus (message : « Le dossier de la session n'existe plus (worktree supprimé ?) : <cwd> ») ; aussi `sessions.diff`, `sessions.diffFile`, `sessions.sendReview` |
| `-32017` | diff impossible : « la session n'est pas dans un dépôt git » |

## 4. Méthodes

| Méthode | Paramètres | Résultat |
|---|---|---|
| `hello` | `{client?}` | `{server: "orchd", version, protocol: 1, pid}` |
| `profiles.list` | — | `{profiles: [Profil]}` |
| `projects.resolve` | `{path}` | `{path, exists, inferred, is_git, root, worktree_root, common_dir, branch, name}` (voir ci-dessous) |
| `sessions.list` | — | `{sessions: [Session]}`, de la plus récente à la plus ancienne |
| `sessions.get` | `{id}` | `{session: Session}` |
| `sessions.launch` | `{cwd, profile?, model?, mode?, prompt?, cols?, rows?}` | `{session: Session, warnings: [texte]}` |
| `sessions.resume` | `{id}` ou `{claude_session_id, cwd?, profile?}`, plus `{mode?, model?, prompt?, cols?, rows?}` | `{session: Session, warnings: [texte]}` |
| `sessions.subscribe` | `{id, history?}` | `{id, snapshot: Écran, history?}` puis le flux (§ 6) |
| `sessions.unsubscribe` | `{id}` | `{unsubscribed: bool}` |
| `sessions.resize` | `{id, cols, rows}` | `{cols, rows}` |
| `sessions.input` | `{id, data}` | `{}` une fois le texte mis en file (texte UTF-8 ; les trames `0x03` sont préférables pour le clavier) |
| `sessions.stop` | `{id}` | `{stopping: bool, alive: bool}` |
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
| `files.list` | `{id, path?}` | `{root, path, entries, truncated}` (voir « Fichiers d'une session ») |
| `files.read` | `{id, path}` | `{path, size, binary, too_large, content}` |

Détails :

- **`cwd`** : chemin absolu d'un dossier existant (résolu, liens suivis). **`profile`** : nom d'un profil de `profiles.list` (`default` par défaut). **`mode`** : `default` (ou `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` ; absent = le mode par défaut de Claude Code pour ce profil (aucun `--permission-mode` passé). **`cols`/`rows`** : 1 à 1000 (80×24 par défaut au lancement, taille courante à la reprise).
- **`projects.resolve`** passe par la CLI `git` : `root` est le worktree principal (parent du dossier commun quand il s'appelle `.git`), `worktree_root` la racine du worktree contenant `path`, `common_dir` le dossier commun (identifiant du projet), `branch` absente en HEAD détachée ou avant le premier commit. Hors dépôt (ou sans `git`) : `is_git: false`, `root` = `path`, le reste `null`. Dossier existant : `exists: true, inferred: false`.
  - **Dossier disparu** (worktree supprimé ; `path` absolu, sinon `-32602`) : `exists: false`, rien n'est créé, et le projet est deviné :
    1. un voisin : si le premier composant manquant s'appelle `<nom>--<suffixe>` ou `<nom>.<suffixe>`, le dossier `<parent>/<nom>` s'il est la racine d'un dépôt git (préfixe le plus long d'abord) ;
    2. sinon le dépôt qui contient le plus proche ancêtre existant, **seulement** si le chemin est rangé comme un worktree de ce dépôt : sous `<racine>/.worktrees/`, sous `<racine>/.claude/worktrees/`, ou directement sous `<racine>` (premier composant manquant enfant de la racine). Un dépôt lointain (par exemple un dépôt de fichiers de configuration dans `~` pour `~/a/b/c`) n'est pas retenu.

    Lu par `git` et sur le disque, hors du runtime du démon.

    Trouvé : `{"path": "<path>", "exists": false, "inferred": true, "is_git": true, "root": "<racine du dépôt>", "worktree_root": null, "common_dir": "…", "branch": null, "name": "<nom du dépôt>"}`. Sinon : `{"path": "<path>", "exists": false, "inferred": false, "is_git": false, "root": null, "worktree_root": null, "common_dir": null, "branch": null, "name": "<dernier composant>"}`.
- **`sessions.launch`** choisit un UUID qui sert à la fois d'identifiant interne (`id`) et de `--session-id` pour Claude Code (`claude_session_id`). Le second change ensuite sur `/clear` ; seul `id` est stable.
- **`sessions.resume`** :
  - tous les paramètres (profil, mode, taille, dossier, binaire `claude`) sont vérifiés avant de toucher à la session ; si la reprise échoue (y compris au lancement du processus), `sessions.list` est inchangé et l'écran n'est pas effacé ;
  - avec `id` : la session du démon, qui ne doit pas tourner (`-32002` sinon), est relancée avec `--resume <claude_session_id>`. Si son processus vient de se terminer mais que le démon ne l'a pas encore constaté (délai de grâce de 0,5 s laissé à un `SessionEnd` en retard), la fin est constatée sur-le-champ et la reprise a lieu. La session garde son `id`, son terminal et ses abonnés (le démon envoie `ESC[0m CRLF ESC[2J ESC[H` dans le flux juste avant la première sortie du nouveau processus) ;
  - avec `claude_session_id` seul : si une session arrêtée du démon porte ce `claude_session_id`, c'est elle qui est reprise ; sinon (ancienne session trouvée par `transcripts.list`) une nouvelle entrée est créée, `cwd` est alors obligatoire. Elle reprend le nom de la conversation : `first_prompt` et titre de Claude Code (`aiTitle`/`summary`, dans `metrics.session_name`) lus dans le transcript du profil, et `title`/`color` d'une autre entrée du démon pour le même `claude_session_id` s'il y en a ;
  - les paramètres absents reprennent ceux de la session (profil, mode, modèle, taille).
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
- **`transcripts.list`** : chaque ancienne session porte aussi `display_name` (toujours un texte) : le `title` d'une session du démon qui a le même `claude_session_id`, sinon le titre donné par Claude Code (`title` : `aiTitle` ou `summary` du transcript), sinon `first_prompt`, sinon les 8 premiers caractères de `claude_session_id` (mêmes règles de mise sur une ligne et de coupe à 60 caractères).

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

**`sessions.sendReview {id, comments: [{path, line, side: "new" | "old", text}], general?}`** → `{sent: true}` :

- Validation (`-32602`, rien n'est envoyé) : au plus **200** commentaires ; `path` dans la liste de `sessions.diff` ; `line` entier ≥ 1 (numéro dans la nouvelle version pour `side: "new"`, dans l'ancienne pour `"old"`) ; `text` non vide, `text` et `general` d'au plus **4 000** caractères ; au moins un commentaire ou un `general` non vide. La session doit tourner (`-32002` « la session ne tourne pas… » sinon) et n'avoir **aucune demande en attente** (statut `waiting`, permission ou question : `-32002` « une demande attend une réponse dans la session », l'Entrée validerait le dialogue de la TUI). Chemins validés sur la liste de la session (moins de 2 s, comme `sessions.diffFile`).
- Envoi (architecture § 9, prototype n° 1 Q8 : la consigne est tapée, seul le contenu est collé) : la consigne tapée « Voici ma revue de tes changements, applique-la puis dis-moi ce que tu as fait : », puis la revue collée en *bracketed paste* (`ESC[200~ … ESC[201~`), puis Entrée (80 ms entre les trois). Le verrou des écritures de la session est tenu pendant les trois envois : une autre revue, des Shift+Tab (`sessions.setMode`) ou une entrée passée par le démon (trames `0x03`, `sessions.input`) attendent derrière et ne s'intercalent jamais ; des touches tapées par l'utilisateur dans ces 160 ms attendent aussi, puis suivent la revue. Si Claude travaille, Claude Code met le message en file d'attente.
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
  ````

  Pour chaque commentaire : `### <chemin>:<ligne>` (« (ancienne version) » pour `side: "old"`), l'extrait du diff (± 2 lignes autour de la ligne, dans son bloc ; absent si la ligne n'est pas dans le diff), puis le commentaire. La clôture du bloc de code est plus longue que toute suite de « ` » de l'extrait. Tous les caractères de contrôle sauf saut de ligne et tabulation sont retirés de ce qui est collé (commentaires, chemins, extraits) : rien ne peut sortir du collage encadré ni taper de touche.

### Fichiers d'une session (v0.2, lot 3)

**Racine** : la racine du worktree si le dossier de la session est dans un dépôt git (même si la session a été lancée dans un sous-dossier), sinon le dossier de la session ; toujours résolue (`root`, chemin absolu). Les deux méthodes marchent pour une session arrêtée tant que son dossier existe. Erreurs : `-32001` session inconnue, `-32016` dossier disparu, `-32602` chemin refusé ou invalide (message en français), `-32603` échec de lecture ou de `git`.

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
{"path": "README.md", "size": 9, "binary": false, "too_large": false, "content": "# Projet\n"}
```

- Les liens symboliques sont suivis s'ils restent **dans** la racine (`RESOLVE_BENEATH` : un lien absolu, même vers la racine, est refusé), jamais vers `.git`. Le fichier est d'abord ouvert en `O_PATH` (aucun effet de bord) et doit être un fichier ordinaire : dossier, FIFO, périphérique ou socket refusés (`-32602`) ; puis il est rouvert pour la lecture (même inode vérifié).
- Au plus **2 Mio** : au-delà, `too_large: true`, `content: null` (rien n'est lu). Binaire (octet nul dans les 8 000 premiers octets) : `binary: true`, `content: null`. Sinon `content` : le texte en UTF-8 (octets invalides remplacés par « � »). `path` : le chemin demandé, normalisé.
- Un fichier ignoré par `.gitignore` reste lisible par son chemin (seule la liste le masque).
- « Mentionner à Claude » : le front tape `@<path> ` par `sessions.input` (sans Entrée).

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

Pour un client lent, les `session.updated` en attente d'une même session sont **regroupés** : il reçoit l'état le plus récent au moment de l'envoi, pas chaque étape. Les `session.effect` ne sont pas regroupés ; si plus de 4 096 événements attendent (ou si le client a pris trop de retard sur le démon), la file est remplacée par un `session.removed` pour chacune des dernières sessions oubliées (jusqu'à 1 024, éventuellement déjà connues du client : à ignorer si l'`id` est inconnu) puis un `session.updated` par session, et les effets en trop sont perdus. Le dernier `session.updated` reçu fait toujours foi.

### Effet

```json
{"type": "notify_waiting", "request_id": 1, "pending": Demande}
{"type": "request_resolved", "request_id": 1, "how": "answered|answered_by_app|failed|denied|superseded|cleared"}
{"type": "clear_waiting"}
{"type": "possibly_stale", "request_ids": [1, 2]}
{"type": "dangerous_mode_detected", "mode": "bypassPermissions"}
```

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
  "model": "opus",                      // modèle demandé au lancement, ou null
  "mode": "default",                    // dernier mode connu (hooks, pied de la TUI), sinon celui demandé
  "status": {"state": "starting|running|waiting|idle|error|stopped",
             "wait": "permission|question",          // si waiting
             "reason": "prompt_input_exit"},         // si stopped
  "pending": [{"request_id": 1, "answerable": true, "pending": Demande,
               "tool_use_id": "toolu_…", "agent_id": null, "since": "RFC 3339"}],
  "possibly_stale": false,
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
  "size": {"cols": 100, "rows": 30}
}
```

Tout champ peut être `null` quand la donnée est inconnue (principe 4).

Raisons d'arrêt (`status.reason`) : celles de Claude Code (`prompt_input_exit`, `clear`, `logout`, `other`…) quand un `SessionEnd` est arrivé, sinon :

| Raison | Cas |
|---|---|
| `stopped_by_app` | arrêt demandé (`sessions.stop`, arrêt du démon) sans `SessionEnd` |
| `process_exit` | le processus est sorti seul, code 0, sans `SessionEnd` |
| `daemon_restart` | session active au moment où le démon a disparu (plantage) ; relue arrêtée au redémarrage |

Un processus sorti avec un code non nul ou tué par un signal inattendu, sans `SessionEnd`, donne `state: "error"`. Toute session arrêtée ou en erreur est reprenable.

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

### Profil, ancienne session

```json
{"name": "work", "config_dir": "/home/u/.claude-work", "sets_config_dir_env": true}
{"claude_session_id": "…", "transcript_path": "…", "cwd": "…", "git_branch": "…",
 "first_prompt": "…", "title": "…", "display_name": "…",
 "first_timestamp": "…", "last_timestamp": "…", "last_activity": "…", "message_count": 12,
 "hidden": false}
```

Entrée de `transcripts.list` (ancienne session) :

| Champ | Type | Contenu |
|---|---|---|
| `claude_session_id` | texte | nom du fichier quand c'est un UUID, sinon `sessionId` lu dans le transcript |
| `transcript_path` | texte | chemin absolu du fichier `.jsonl` |
| `cwd` | texte absolu \| `null` | `cwd` de la première ligne qui en porte un (`null` s'il n'y en a pas ou s'il n'est pas absolu ; le nom du dossier du transcript n'est jamais décodé) : de quoi regrouper par dossier, et par dépôt avec `projects.resolve` |
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

Les préfixes gardent leur `_` final : `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` est un réglage. Les variables de **configuration** documentées sont transmises telles quelles (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `ANTHROPIC_*`, mandataires `HTTP(S)_PROXY`, clés d'API…). Le `claude` lancé pose ensuite ses propres marqueurs pour ses hooks et sa statusline (dont nos relais), comme d'habitude.

Le démon rattache une trame à sa session **par le jeton** (comparé en temps constant), jamais par le `session_id` du JSON (qui change sur `/clear`). Jeton inconnu (session terminée, faux jeton) : trame ignorée.

- **`orchd hook <événement>`** (sauf `PermissionRequest`) lit stdin, envoie une trame `0x10`, attend l'accusé `0x12` (envoyé une fois l'événement appliqué : les hooks d'une session sont traités dans l'ordre où Claude Code les lance), puis sort. Budget total : 1 s, 0,5 s pour `SessionEnd` (qui partage 1,5 s avec les hooks de fin de l'utilisateur). Il n'écrit **jamais** rien et sort **toujours** en 0 : démon absent, variable manquante, JSON illisible, délai dépassé, tout est silencieux.
- **`orchd hook PermissionRequest --wait <s>`** (relais bloquant, ADR 0003) :
  1. envoie la trame `0x10` et garde la connexion ouverte ;
  2. le démon applique l'événement, puis rattache le relais à la demande créée ou retrouvée (même demande déjà connue : il s'y ajoute) ; la demande passe `answerable: true` ;
  3. réponse de l'app → trame `0x13` : le relais écrit ce JSON (suivi d'un saut de ligne) sur sa sortie standard, puis sort en 0. Forme : `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow" | "deny", …}}}` (§ 4) ;
  4. libération **sans décision** → trame `0x12`, rien n'est écrit, sortie en 0 : demande close par un autre chemin (`PostToolUse` après une réponse dans la TUI, `PostToolUseFailure`, `PermissionDenied`, `Stop`, `StopFailure`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`), processus `claude` terminé, session arrêtée, arrêt du démon (les relais sont libérés dès le début de l'arrêt), ou trame que le démon ne peut rattacher (jeton inconnu, JSON illisible, session arrêtée) ;
  5. délai `--wait` dépassé ou démon disparu (fin de connexion) : rien n'est écrit, sortie en 0. Le démon voit la connexion se fermer et détache le relais (`answerable: false`) ; la demande reste affichée (la TUI la montre toujours).

  Le relais n'autorise **jamais** rien de lui-même. Le `timeout` du hook est écrit dans `hooks.json` (600 s, le défaut de Claude Code) et `--wait` vaut ce délai moins une marge (5 s ; un quart du délai, au moins 1 s, pour un délai court) : le relais rend la main avant que Claude Code ne le tue. La variable `DEVMAESTRO_PERMISSION_TIMEOUT_SECS` du **démon** (2 à 3600) change ce délai, pour les tests ; elle n'est jamais transmise à `claude`.
- **`orchd statusline --config-dir <dossier du profil>`** envoie une trame `0x11` et attend l'accusé `0x12` (300 ms au plus, en parallèle de la suite : le démon vérifie que l'expéditeur, encore vivant, est un processus de la session), lance la statusline de l'utilisateur (`statusLine.command` de `<dossier>/settings.json`, par `sh -c` dans son propre groupe de processus, même stdin) et affiche sa sortie. Au bout de 2 s (commande trop lente, ou descendant en arrière-plan qui garde la sortie ouverte), tout le groupe est tué et le relais affiche ce qui a été écrit jusque-là ; à défaut, une ligne `DevMaestro · contexte 3 % · 0,22 $`. La variable `DEVMAESTRO_STATUSLINE_CHAINED` posée pour la statusline de l'utilisateur empêche une boucle.

Fichiers générés (au démarrage du démon et avant chaque lancement) :

- `$XDG_DATA_HOME/devmaestro/claude-plugin/` : `.claude-plugin/plugin.json` et `hooks/hooks.json`, où chaque événement (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart`, `SubagentStop`) appelle `<orchd> hook <événement>` en forme exec (`command` + `args`) ; matcher `*` pour les événements d'outil ; `PermissionRequest` porte en plus `"timeout": 600` et `args: ["hook", "PermissionRequest", "--wait", "595"]` ;
- `$XDG_DATA_HOME/devmaestro/settings/<profil>.json` : `{"statusLine": {"type": "command", "command": "'<orchd>' statusline --config-dir '<dossier>'"}}`, plus `"permissions": {"disableBypassPermissionsMode": "disable"}` quand `allow_dangerous_modes` est faux (Claude Code refuse alors d'entrer en `bypassPermissions` ; ce verrou applique la valeur la plus stricte de toutes les sources). Il n'existe pas de verrou équivalent pour `dontAsk` (qui refuse, au lieu d'autoriser, tout ce qui demanderait une permission).

## 9. Cycle de vie et persistance

- **Scope systemd** : si `systemd-run --user --scope` fonctionne au démarrage du démon (gestionnaire systemd utilisateur joignable ; désactivable par `DEVMAESTRO_SYSTEMD_SCOPE=off`), chaque lancement devient `systemd-run --user --scope --quiet --collect --unit=devmaestro-session-<id8>-<alea8>.scope -- claude …` : `systemd-run` s'inscrit dans le scope puis exécute `claude` à sa place (même pid, même PTY, même environnement et dossier). Sinon, lancement direct. Le mode est écrit au journal au démarrage et dans `Session.scope`. Pour les tests seulement, `DEVMAESTRO_SYSTEMD_RUNTIME_DIR` donne à `systemd-run` le vrai `XDG_RUNTIME_DIR` quand celui du démon est temporaire.
- Lancement : `claude (--session-id <uuid> | --resume <id>) [--permission-mode <mode>] [--model <m>] --plugin-dir <plugin> --settings <réglages du profil> [-- "<prompt>"]` dans un PTY, `cwd` = le dossier demandé, avec `TERM=xterm-256color`, `COLORTERM=truecolor`, les variables du § 8 (marqueurs de session Claude Code hérités retirés), et `CLAUDE_CONFIG_DIR` pour les profils autres que `default` (retiré de l'environnement hérité pour `default`). Le mode `default` s'écrit `manual` sur la ligne de commande. Le binaire vient de `DEVMAESTRO_CLAUDE_BIN`, sinon du `PATH` du démon. Le prompt suit `--` (fin des options façon commander.js, d'après `claude --help`) : un prompt comme `--dangerously-skip-permissions` ou `- liste` n'est pas lu comme une option. **À vérifier avec le vrai CLI** : que `--` est accepté et qu'un prompt égal au nom d'une sous-commande (`mcp`, `update`…) n'est pas lancé comme telle.
- À la fin du processus `claude`, son groupe de processus reçoit `SIGHUP` (outils restés en arrière-plan), comme à la fermeture d'un terminal.
- Les sessions sont enregistrées dans `$XDG_DATA_HOME/devmaestro/state.db` (SQLite, WAL, `synchronous=NORMAL`) : identifiants, profil, dossiers, branche, modèle, mode, statut, dates, pid, (schéma v2) date de démarrage du processus et scope systemd, (schéma v3) titre, couleur, premier prompt et dernier `session_name` de la statusline, et (schéma v4) la table `hidden_transcripts (profile, claude_session_id, hidden_at)` des transcripts masqués. Au redémarrage après un plantage, les processus `claude` relus dont des processus vivent encore (eux-mêmes, ou d'autres dans leur groupe ou leur session) restent refusés au socket de contrôle (§ 10). Écriture à chaque changement de statut ou de champ ; une session qui ne change que par sa dernière activité est réécrite au plus toutes les 30 s. Le schéma est versionné (`PRAGMA user_version`, migrations pas à pas) : une base d'une version plus récente est refusée (le démon ne démarre pas, message en français) ; une base illisible ou corrompue est renommée `state.db.corrupt-<horodatage>` et remplacée par une base vide (avertissement au journal).
- Droits : dossiers `$XDG_RUNTIME_DIR/devmaestro`, `$XDG_DATA_HOME/devmaestro` et `$XDG_STATE_HOME/devmaestro` en 0700 (refusés s'ils sont un lien symbolique ou appartiennent à un autre utilisateur), base, journal, plugin et réglages en 0600.
- **Arrêter le démon termine les sessions** : `SIGTERM`, `SIGINT` ou `SIGHUP` → `SIGHUP` à chaque session (le socket reste ouvert pour recevoir les `SessionEnd`), `SIGKILL` au bout de 3 s, puis fin. Un second signal pendant cet arrêt envoie `SIGKILL` à toutes les sessions et sort aussitôt. Les sessions restent reprenables. Après un plantage du démon, les sessions qui étaient en démarrage, en cours, à répondre ou inactives sont relues arrêtées (`daemon_restart`) ; celles déjà arrêtées ou en erreur sont relues telles quelles (statut et date inchangés).
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
  2. pair dans un **scope systemd de session** (`/proc/<pid>/cgroup` contient `devmaestro-session-…scope`). L'appartenance à un cgroup survit à `setsid`, aux doubles forks et au rattachement à `init` : en sortir demande un appel **délibéré** à `systemd-run` (ou l'écriture dans un autre cgroup de l'utilisateur). Seulement quand les sessions sont lancées dans un scope (§ 9) ;
  3. `ORCH_TOKEN=` ou `ORCH_SESSION=` dans l'environnement du pair (`/proc/<pid>/environ`) : un descendant qui n'a pas nettoyé son environnement. Un environnement illisible ne fait pas refuser (un processus peut aussi simplement retirer ces variables) ;
  4. pair = processus `claude` supervisé, actuel, passé, ou relu en base après un plantage du démon, ou l'un de ses descendants : chaîne des parents remontée dans `/proc`, et à chaque étape groupe et session comparés à ceux des sessions (lancées par `setsid` : pid = groupe = session). Les processus supervisés sont identifiés par leur date de démarrage : un pid réattribué depuis ne fait pas refuser un client légitime ; une date inconnue ne correspond à rien. Un processus supervisé disparu, dont plus aucun processus ne vit dans son groupe ni sa session, est oublié.
  
  Le pair est épinglé par `SO_PEERPIDFD` (noyau 6.5 et plus) : après les lectures de `/proc`, le démon vérifie que ce processus vit toujours (son pid n'a donc pas été réattribué entre l'acceptation et la fin des contrôles). Sans pidfd, la date de démarrage du pid est relue et comparée.
- **Socket des relais** : une trame n'est acceptée que si son jeton désigne une session vivante **et** si le pair descend du processus `claude` de cette session (ou partage son scope systemd). Un processus d'une session ne peut donc rien envoyer pour une **autre** session. En revanche, un processus d'une session connaît le jeton de **sa** session et peut forger des événements pour elle (une fausse demande, une fausse fin de tour) : l'app affiche toujours le contenu exact de la demande, et « Toujours » ne reprend que les suggestions de la **première** trame d'une demande, seulement des règles qui correspondent à l'outil et à l'entrée de la demande (`toolName` égal ; pour `Bash`, `ruleContent` obligatoire, égal à la commande ou préfixe `…:*` qu'elle prolonge ; pour les outils de fichiers, `ruleContent` obligatoire, égal au chemin ou `<dossier absolu>/**` qui le contient).
- **Environnement de `claude`** : les variables `ORCH_*` et `DEVMAESTRO_*` héritées sont retirées, ainsi que les marqueurs de session Claude Code (§ 8), dont le jeton de messagerie d'une session parente (`CLAUDE_CODE_MESSAGING_TOKEN`).
- **Modes qui suppriment les demandes** (`bypassPermissions`, `dontAsk`) : réglage explicite du démon (§ 9), y compris quand ils viennent d'un `defaultMode` du projet ou du profil ; `bypassPermissions` verrouillé dans les réglages passés à `claude` ; passage détecté et signalé (`dangerous_mode_detected`).
- **Le relais n'autorise jamais rien par défaut** (délai, démon absent : sortie sans décision).

- **Identifiants Claude Code et réseau** : le démon lit (jamais n'écrit) le jeton OAuth de chaque profil (`.credentials.json`) pour l'API d'usage ; il ne l'envoie qu'à `https://api.anthropic.com/api/oauth/usage` en HTTPS (TLS rustls, sans suivre de redirection ni passer par un mandataire), ne le journalise pas et ne le renvoie à aucun client. C'est la seule connexion sortante du démon ; elle se coupe par `[quotas] usage_api = false` (§ 9). Aucun port n'est ouvert.

### Ce qui n'est pas protégé (atténuation, pas un bac à sable)

- **Sans scope systemd** (pas de gestionnaire utilisateur) : un processus qui crée sa propre session (`setsid -f`) **et** nettoie son environnement n'est plus reconnu (constaté par les tests). Avec un scope, il faut en plus en sortir délibérément.
- Un processus de l'utilisateur peut lire ses fichiers et, selon `ptrace_scope`, la mémoire de ses autres processus (dont le démon et l'app), ou écrire dans ses autres cgroups.
- Un processus lancé par l'utilisateur **depuis** une session (par exemple l'app de développement lancée dans un terminal d'une session DevMaestro) est refusé sur le socket de contrôle : la lancer hors des sessions.
- `orchd ctl` passe par le socket de contrôle comme le front : il fonctionne depuis un terminal ordinaire, pas depuis une session supervisée.
