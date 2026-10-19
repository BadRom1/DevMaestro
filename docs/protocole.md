# Protocole du socket d'`orchd`

> Contrat entre le démon `orchd` et ses clients : le front Electron (lot 4), le client de mise au point `orchd ctl` et les relais `orchd hook` / `orchd statusline`.
> Version du protocole : **1** (renvoyée par `hello`). Code : `crates/core/src/protocol/`, `crates/core/src/daemon/server.rs`.
> Références : [architecture § 4, § 7, § 9, § 14, § 15](architecture.md), [ADR 0001](adr/0001-demon-orchd.md), [ADR 0002](adr/0002-injection-des-hooks.md).

## 1. Transport

- Socket Unix `$XDG_RUNTIME_DIR/devmaestro/orchd.sock` (repli si la variable est absente : `$TMPDIR/devmaestro-<uid>/`, sinon `/tmp/devmaestro-<uid>/`). Le dossier est en `0700`, le socket en `0600`. Aucun port TCP.
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
- Un type inconnu est ignoré par le destinataire (compatibilité ascendante).
- Une trame mal formée (longueur nulle ou trop grande, UUID tronqué, chaîne de hook tronquée ou non UTF-8, trame coupée) **ferme la connexion** : le démon ne cherche pas à se resynchroniser au milieu d'un flux.

| Type | Nom | Sens | Charge utile |
|---|---|---|---|
| `0x01` | JSON-RPC | les deux | un message JSON-RPC 2.0, en UTF-8 |
| `0x02` | sortie PTY | démon → client | UUID de session (16 octets, ordre RFC 4122) + octets bruts du terminal |
| `0x03` | entrée PTY | client → démon | UUID de session (16 octets) + octets à écrire dans le terminal (touches, collage) |
| `0x10` | hook | relais → démon | jeton, nom d'événement, JSON brut (voir ci-dessous) |
| `0x11` | statusline | relais → démon | jeton, JSON brut |
| `0x12` | accusé | démon → relais | vide |

Chaînes des trames `0x10` et `0x11` : longueur `u16` gros-boutiste puis octets UTF-8.

```
0x10 : [u16 len][jeton][u16 len][événement][JSON du hook, jusqu'à la fin]
0x11 : [u16 len][jeton][JSON de la statusline, jusqu'à la fin]
```

Exemple : un hook `Stop` avec le jeton `t` et le JSON `{}` s'écrit `00 00 00 0c 10 00 01 74 00 04 53 74 6f 70 7b 7d`.

Les octets d'un PTY ne sont **jamais** analysés par le démon pour en déduire un état (architecture § 6) : ils servent à l'affichage.

## 3. JSON-RPC 2.0

- Requêtes `{"jsonrpc":"2.0","id":…,"method":…,"params":{…}}`, réponses `result` ou `error` avec le même `id`. Une requête sans `id` est une notification : traitée, sans réponse. Pas de lots (tableaux).
- Les requêtes d'une connexion sont traitées **dans l'ordre**.
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

## 4. Méthodes

| Méthode | Paramètres | Résultat |
|---|---|---|
| `hello` | `{client?}` | `{server: "orchd", version, protocol: 1, pid}` |
| `profiles.list` | — | `{profiles: [Profil]}` |
| `projects.resolve` | `{path}` | `{path, is_git, root, worktree_root, common_dir, branch, name}` (voir ci-dessous) |
| `sessions.list` | — | `{sessions: [Session]}`, de la plus récente à la plus ancienne |
| `sessions.get` | `{id}` | `{session: Session}` |
| `sessions.launch` | `{cwd, profile?, model?, mode?, prompt?, cols?, rows?}` | `{session: Session}` |
| `sessions.resume` | `{id}` ou `{claude_session_id, cwd?, profile?}`, plus `{mode?, model?, prompt?, cols?, rows?}` | `{session: Session}` |
| `sessions.subscribe` | `{id, history?}` | `{id, snapshot: Écran, history?}` puis le flux (§ 6) |
| `sessions.unsubscribe` | `{id}` | `{unsubscribed: bool}` |
| `sessions.resize` | `{id, cols, rows}` | `{cols, rows}` |
| `sessions.input` | `{id, data}` | `{}` une fois le texte mis en file (texte UTF-8 ; les trames `0x03` sont préférables pour le clavier) |
| `sessions.stop` | `{id}` | `{stopping: bool, alive: bool}` |
| `sessions.setMode` | `{id, mode}` | **lot 3** (renvoie `-32601` pour l'instant) |
| `transcripts.list` | `{profile?, limit?}` (50 par défaut) | `{profile, sessions: [AncienneSession]}` |

Détails :

- **`cwd`** : chemin absolu d'un dossier existant (résolu, liens suivis). **`profile`** : nom d'un profil de `profiles.list` (`default` par défaut). **`mode`** : `default` (ou `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` ; absent = le mode par défaut de Claude Code pour ce profil (aucun `--permission-mode` passé). **`cols`/`rows`** : 1 à 1000 (80×24 par défaut au lancement, taille courante à la reprise).
- **`projects.resolve`** passe par la CLI `git` : `root` est le worktree principal (parent du dossier commun quand il s'appelle `.git`), `worktree_root` la racine du worktree contenant `path`, `common_dir` le dossier commun (identifiant du projet), `branch` absente en HEAD détachée ou avant le premier commit. Hors dépôt (ou sans `git`) : `is_git: false`, `root` = `path`, le reste `null`.
- **`sessions.launch`** choisit un UUID qui sert à la fois d'identifiant interne (`id`) et de `--session-id` pour Claude Code (`claude_session_id`). Le second change ensuite sur `/clear` ; seul `id` est stable.
- **`sessions.resume`** :
  - tous les paramètres (profil, mode, taille, dossier, binaire `claude`) sont vérifiés avant de toucher à la session ; si la reprise échoue (y compris au lancement du processus), `sessions.list` est inchangé et l'écran n'est pas effacé ;
  - avec `id` : la session du démon, qui ne doit pas tourner (`-32002` sinon), est relancée avec `--resume <claude_session_id>`. Si son processus vient de se terminer mais que le démon ne l'a pas encore constaté (délai de grâce de 0,5 s laissé à un `SessionEnd` en retard), la fin est constatée sur-le-champ et la reprise a lieu. La session garde son `id`, son terminal et ses abonnés (le démon envoie `ESC[0m CRLF ESC[2J ESC[H` dans le flux juste avant la première sortie du nouveau processus) ;
  - avec `claude_session_id` seul : si une session arrêtée du démon porte ce `claude_session_id`, c'est elle qui est reprise ; sinon (ancienne session trouvée par `transcripts.list`) une nouvelle entrée est créée, `cwd` est alors obligatoire ;
  - les paramètres absents reprennent ceux de la session (profil, mode, modèle, taille).
- **`sessions.stop`** envoie `SIGHUP` au groupe de processus de `claude`, puis `SIGKILL` au bout de 3 s s'il tourne encore. La réponse arrive tout de suite ; la fin est annoncée par `session.updated` (`alive: false`).

## 5. Notifications du démon

| Méthode | Paramètres | Quand |
|---|---|---|
| `session.updated` | `{session: Session}` | à chaque changement : lancement, hook, statusline (si les mesures changent), fin du processus, reprise |
| `session.effect` | `{id, effect: Effet}` | effets de la machine à états, juste **avant** le `session.updated` correspondant |
| `session.resync` | `{id, snapshot: Écran}` | un abonné a pris trop de retard (§ 6) |

Pour un client lent, les `session.updated` en attente d'une même session sont **regroupés** : il reçoit l'état le plus récent au moment de l'envoi, pas chaque étape. Les `session.effect` ne sont pas regroupés ; si plus de 4 096 événements attendent (ou si le client a pris trop de retard sur le démon), la file est remplacée par un `session.updated` par session et les effets en trop sont perdus. Le dernier `session.updated` reçu fait toujours foi.

### Effet

```json
{"type": "notify_waiting", "request_id": 1, "pending": Demande}
{"type": "request_resolved", "request_id": 1, "how": "answered|failed|denied|superseded|cleared"}
{"type": "clear_waiting"}
{"type": "possibly_stale", "request_ids": [1, 2]}
```

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
  "profile": "default", "cwd": "/…", "project_root": "/…", "branch": "main",
  "model": "opus",                      // modèle demandé au lancement, ou null
  "mode": "default",                    // dernier permission_mode connu (hooks), sinon celui demandé
  "status": {"state": "starting|running|waiting|idle|error|stopped",
             "wait": "permission|question",          // si waiting
             "reason": "prompt_input_exit"},         // si stopped
  "pending": [{"request_id": 1, "pending": Demande, "tool_use_id": "toolu_…",
               "agent_id": null, "since": "RFC 3339"}],
  "possibly_stale": false,
  "metrics": {"model": {"id": "…", "display_name": "…"}, "cost_usd": 0.22,
              "context_used_pct": 3, "context_window_size": 1000000, "total_tokens": 26720,
              "rate_limits": {"five_hour": {"used_pct": 2, "resets_at": "RFC 3339"}, "seven_day": null},
              "session_name": "…"},
  "last_activity": "RFC 3339",          // dernier hook reçu
  "created_at": "RFC 3339", "updated_at": "RFC 3339",
  "alive": true, "pid": 1234,           // processus claude en cours
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
{"kind": "permission", "tool_name": "Bash", "tool_input": {…}}
{"kind": "question", "tool_name": "AskUserQuestion", "tool_input": {…},
 "questions": [{"question": "…", "header": "…", "multi_select": false,
                "options": [{"label": "…", "description": "…"}]}]}
{"kind": "permission" | "question", "detailed": false}     // connue seulement par une Notification
```

### Profil, ancienne session

```json
{"name": "work", "config_dir": "/home/u/.claude-work", "sets_config_dir_env": true}
{"claude_session_id": "…", "transcript_path": "…", "cwd": "…", "git_branch": "…",
 "first_prompt": "…", "title": "…", "first_timestamp": "…", "last_timestamp": "…", "message_count": 12}
```

## 8. Relais (`orchd hook`, `orchd statusline`)

Lancés par Claude Code, avec l'environnement du processus `claude` :

| Variable | Valeur |
|---|---|
| `ORCH_SOCKET` | chemin du socket |
| `ORCH_TOKEN` | jeton de 16 octets tirés du générateur aléatoire du système (`getrandom`), en hexadécimal (32 caractères), propre au processus `claude` en cours ; renouvelé à chaque reprise |
| `ORCH_SESSION` | identifiant interne de la session (information, jamais utilisé pour authentifier) |

Le démon rattache une trame à sa session **par le jeton** (comparé en temps constant), jamais par le `session_id` du JSON (qui change sur `/clear`). Jeton inconnu (session terminée, faux jeton) : trame ignorée.

- **`orchd hook <événement>`** lit stdin, envoie une trame `0x10`, attend l'accusé `0x12` (envoyé une fois l'événement appliqué : les hooks d'une session sont traités dans l'ordre où Claude Code les lance), puis sort. Budget total : 1 s, 0,5 s pour `SessionEnd` (qui partage 1,5 s avec les hooks de fin de l'utilisateur). Il n'écrit **jamais** rien et sort **toujours** en 0 : démon absent, variable manquante, JSON illisible, délai dépassé, tout est silencieux. Au lot 2, `PermissionRequest` est relayé sans décision (la TUI garde la main) ; au lot 3, le démon répondra sur la même connexion.
- **`orchd statusline --config-dir <dossier du profil>`** envoie une trame `0x11` sans attendre de réponse (300 ms au plus), lance la statusline de l'utilisateur (`statusLine.command` de `<dossier>/settings.json`, par `sh -c` dans son propre groupe de processus, même stdin) et affiche sa sortie. Au bout de 2 s (commande trop lente, ou descendant en arrière-plan qui garde la sortie ouverte), tout le groupe est tué et le relais affiche ce qui a été écrit jusque-là ; à défaut, une ligne `DevMaestro · contexte 3 % · 0,22 $`. La variable `DEVMAESTRO_STATUSLINE_CHAINED` posée pour la statusline de l'utilisateur empêche une boucle.

Fichiers générés (au démarrage du démon et avant chaque lancement) :

- `$XDG_DATA_HOME/devmaestro/claude-plugin/` : `.claude-plugin/plugin.json` et `hooks/hooks.json`, où chaque événement (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`, `SubagentStart`, `SubagentStop`) appelle `<orchd> hook <événement>` en forme exec (`command` + `args`) ; matcher `*` pour les événements d'outil ;
- `$XDG_DATA_HOME/devmaestro/settings/<profil>.json` : `{"statusLine": {"type": "command", "command": "'<orchd>' statusline --config-dir '<dossier>'"}}`.

## 9. Cycle de vie et persistance

- Lancement : `claude (--session-id <uuid> | --resume <id>) [--permission-mode <mode>] [--model <m>] --plugin-dir <plugin> --settings <réglages du profil> [-- "<prompt>"]` dans un PTY, `cwd` = le dossier demandé, avec `TERM=xterm-256color`, `COLORTERM=truecolor`, les variables du § 8, et `CLAUDE_CONFIG_DIR` pour les profils autres que `default` (retiré de l'environnement hérité pour `default`). Le mode `default` s'écrit `manual` sur la ligne de commande. Le binaire vient de `DEVMAESTRO_CLAUDE_BIN`, sinon du `PATH` du démon. Le prompt suit `--` (fin des options façon commander.js, d'après `claude --help`) : un prompt comme `--dangerously-skip-permissions` ou `- liste` n'est pas lu comme une option. **À vérifier avec le vrai CLI** : que `--` est accepté et qu'un prompt égal au nom d'une sous-commande (`mcp`, `update`…) n'est pas lancé comme telle.
- À la fin du processus `claude`, son groupe de processus reçoit `SIGHUP` (outils restés en arrière-plan), comme à la fermeture d'un terminal.
- Les sessions sont enregistrées dans `$XDG_DATA_HOME/devmaestro/state.db` (SQLite, WAL, `synchronous=NORMAL`) : identifiants, profil, dossiers, branche, modèle, mode, statut, dates, pid. Écriture à chaque changement de statut ou de champ ; une session qui ne change que par sa dernière activité est réécrite au plus toutes les 30 s. Le schéma est versionné (`PRAGMA user_version`, migrations pas à pas) : une base d'une version plus récente est refusée (le démon ne démarre pas, message en français) ; une base illisible ou corrompue est renommée `state.db.corrupt-<horodatage>` et remplacée par une base vide (avertissement au journal).
- Droits : dossiers `$XDG_RUNTIME_DIR/devmaestro`, `$XDG_DATA_HOME/devmaestro` et `$XDG_STATE_HOME/devmaestro` en 0700 (refusés s'ils sont un lien symbolique ou appartiennent à un autre utilisateur), base, journal, plugin et réglages en 0600.
- **Arrêter le démon termine les sessions** : `SIGTERM`, `SIGINT` ou `SIGHUP` → `SIGHUP` à chaque session (le socket reste ouvert pour recevoir les `SessionEnd`), `SIGKILL` au bout de 3 s, puis fin. Un second signal pendant cet arrêt envoie `SIGKILL` à toutes les sessions et sort aussitôt. Les sessions restent reprenables. Après un plantage du démon, les sessions qui étaient en démarrage, en cours, à répondre ou inactives sont relues arrêtées (`daemon_restart`) ; celles déjà arrêtées ou en erreur sont relues telles quelles (statut et date inchangés).
- Journal : sortie d'erreur et `$XDG_STATE_HOME/devmaestro/orchd.log`.
