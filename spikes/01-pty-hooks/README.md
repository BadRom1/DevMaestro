# Prototype n° 1 : outillage

Outillage jetable pour [le prototype n° 1](../../docs/spikes/01-pty-hooks.md). Python 3, bibliothèque standard uniquement. Tout ce qui est produit va dans `out/` (ignoré par git ; `rm -rf out` pour repartir de zéro).

## Fichiers

| Fichier | Rôle |
|---|---|
| `plugin/` | Modèle du plugin (`.claude-plugin/plugin.json`, `hooks/hooks.json`). Devrait fonctionner tel quel avec `--plugin-dir plugin` (délai 600 s, non testé : `run.sh` utilise `out/plugin/`). |
| `make_config.py` | Appelé par `run.sh` : génère `out/plugin/` (chemin absolu du relais, délai `PermissionRequest` choisi) et `out/settings.json` (statusline, et hooks pour la variante `settings-hooks`). |
| `relay.py <événement> [délai]` | Hook : ajoute une ligne à `out/events.jsonl`. Pour `PermissionRequest`, crée `out/pending/<id>.json` et attend `decide.py`. |
| `decide.py` | `list`, puis `allow`, `deny` ou `terminal` (`[id]` facultatif s'il n'y a qu'une demande). |
| `statusline.py` | Journalise dans `out/statusline.jsonl`, puis exécute ta statusline (`statusLine.command` du profil, ou `SPIKE_USER_STATUSLINE`). |
| `ptyhost.py` | Lance `claude` dans un PTY et lit des commandes sur `out/inject.fifo`. |
| `inject.py` | `paste "<texte>"` (`\n` accepté), `paste-file <chemin>`, `keys shift-tab [n]`, `keys enter`, `keys esc`. |
| `show.py` | Une ligne par événement : `show.py`, `show.py -f` (suivi), `show.py --raw N` (JSON complet). |
| `run.sh` | Lance la session (voir ci-dessous). |

```
./run.sh [--profile perso|work] [--variant plugin|settings-hooks] [--mode default|acceptEdits|plan|auto|dontAsk]
         [--timeout N] [--no-ptyhost] [-- "prompt initial"]
```

`run.sh` affiche le `session_id`, le profil et la variante, ajoute une ligne `run.start` (variante, profil, mode, délai, version de claude) dans `out/events.jsonl`, puis lance
`claude --session-id <uuid> --permission-mode <mode> --settings out/settings.json [--plugin-dir out/plugin] [prompt]`
dans `ptyhost.py`. `ORCH_TOKEN` (aléatoire, copié dans `out/expected_token`, droits 600) et `SPIKE_DIR` sont exportés. Le délai vient de `--timeout`, sinon de `SPIKE_HOOK_TIMEOUT`, sinon 600.

- **Mode** : claude 2.1.303 n'accepte pas `--permission-mode default` (choix : `manual`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`). `run.sh` traduit `default` en `manual`, que les hooks rapportent comme `"default"`. Le mode est toujours passé explicitement : ton `defaultMode: auto` ne s'applique donc pas.
- **Une session à la fois** : FIFO, jeton et demandes en attente sont partagés dans `out/`. `run.sh` refuse de démarrer si le pid de `out/run.pid` est vivant.
- `--settings` et `--plugin-dir` prennent une seule valeur (`claude --help` ne les marque pas `<…...>`, contrairement à `--add-dir`) : le prompt, placé en dernier, ne peut pas être pris pour la valeur d'une option.

**Profil perso** : `CLAUDE_CONFIG_DIR` reste vide, comme d'habitude. Le forcer à `~/.claude` ferait lire `~/.claude/.claude.json` (absent) au lieu de `~/.claude.json`. **Profil boulot** : `CLAUDE_CONFIG_DIR=~/.claude-work`, comme `claude-work`.

## Déroulé

Terminal A : la session. Terminal B : `cd spikes/01-pty-hooks; python3 show.py -f`, puis `decide.py` / `inject.py`. Lancer depuis un dossier déjà approuvé : tant que la confiance n'est pas accordée, hooks et statusline restent muets.

1. **Tour simple** (Q1, Q3, Q4, Q11) : `./run.sh -- "Dis bonjour"`.
   peon-ping sonne-t-il ? Dans `show.py` : `token=ok` sur chaque hook (Q3), `session_id=` = les 8 premiers caractères affichés par `run.sh`, ordre des événements. Statusline : ta statusline habituelle s'affiche-t-elle ? `python3 -m json.tool` sur une ligne de `out/statusline.jsonl` (ou `tail -1 out/statusline.jsonl | python3 -m json.tool`) : `context_window.used_percentage`, `cost.total_cost_usd`, `rate_limits`.
2. **Permission** (Q5, Q6) : `./run.sh -- "Lance la commande Bash : touch /tmp/spike-x"`. Une commande qui écrit : une commande en lecture seule comme `ls` peut être autorisée d'office, et alors aucun `PermissionRequest` ne part (`touch` n'est dans aucune règle `allow` de tes profils). Pendant l'attente, regarder la TUI (spinner ? saisie possible ?), puis `python3 decide.py allow`. Recommencer avec `deny`, puis `terminal` (la TUI doit afficher sa propre demande).
3. **Délai dépassé** (Q6) : `./run.sh --timeout 20 -- "Lance la commande Bash : touch /tmp/spike-y"`, ne pas répondre. Le relais abandonne à 15 s (délai − 5) ; `relay.decision outcome="deadline"`. Puis la variante où c'est **claude** qui tue le hook : `SPIKE_RELAY_GRACE=-10 ./run.sh --timeout 20 -- "…"` (le relais attendrait 30 s) ; on doit voir `outcome="killed:SIGTERM"`, ou rien si claude tue autrement.
4. **Question** (Q7) : `./run.sh -- "Demande-moi avec l'outil AskUserQuestion si je préfère A ou B"`. Chercher `PreToolUse tool_name=AskUserQuestion`, puis `show.py --raw N` pour `tool_input.questions`. Le matcher `*` de `PermissionRequest` peut aussi attraper `AskUserQuestion` : le relais retiendrait alors la question jusqu'à ~595 s. Si la question ne s'affiche pas, `python3 decide.py list` (la ligne indique l'outil) puis `python3 decide.py terminal` ; noter ce cas, il compte pour ADR 0003.
5. **Coller et changer de mode** (Q8, Q9) : `./run.sh`, puis dans B :
   `python3 inject.py paste "ligne 1\nligne 2\nligne 3\nligne 4\nligne 5"`, `python3 inject.py keys enter` → un seul `UserPromptSubmit` ?
   `python3 inject.py keys shift-tab 2`, puis `python3 inject.py paste "Dis bonjour"` et `keys enter` → `permission_mode=` du `UserPromptSubmit` suivant.
6. **Hooks dans `--settings`** (Q2) : `./run.sh --variant settings-hooks -- "Dis bonjour"`. peon-ping sonne-t-il ? Les événements arrivent-ils ?
7. **Profil boulot** (Q10) : `./run.sh --profile work -- "Dis bonjour"`. Vérifier le compte (`/status`) et la statusline du profil boulot.
8. **Fin de session** (Q11), l'une après l'autre (une seule session à la fois) : `./run.sh`, puis `/exit` → `SessionEnd reason=…`. Ensuite un nouveau `./run.sh`, fermé par Ctrl+C deux fois → comparer `reason`.

## Lire les journaux sans jq

- `python3 show.py` : `heure  événement  champs clés` (token, session, mode, outil, entrée, raison…).
- Chaque lancement commence par une ligne `RUN <session_id> profil=… variante=… mode=…`. `python3 show.py --session 3f2a` ne garde que la session dont l'id commence par `3f2a`.
- `python3 show.py --raw 12` : la ligne 12 en entier.
- **Ordre approximatif** : chaque hook est un processus à part, et des hooks lancés presque en même temps (ils tournent en parallèle) peuvent s'écrire dans le désordre, à quelques millisecondes près. Pour Q11, se fier à l'ordre entre étapes nettement séparées, pas entre deux lignes au même horodatage.
- `python3 -m json.tool < out/settings.json`, `tail -1 out/statusline.jsonl | python3 -m json.tool`.

## Ce que dit la doc (vérifié le 2026-10-19, Claude Code 2.1.303)

Sources : [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [hooks](https://code.claude.com/docs/en/hooks), [statusline](https://code.claude.com/docs/en/statusline).

- `hooks/hooks.json` enveloppe la table des événements dans une clé `"hooks"`. `plugin.json` est facultatif (`name` seul requis). `claude plugin validate` passe sur `plugin/` et `out/plugin/`.
- Les hooks utilisent la forme *exec* (`command: "python3"`, `args: [...]`) : pas de shell (sinon c'est `sh -c`, pas bash), `${CLAUDE_PLUGIN_ROOT}` remplacé dans `args`.
- `timeout` est en secondes, 600 par défaut pour les hooks `command`. C'est un nombre JSON : il ne lit pas de variable d'environnement, d'où la génération par `make_config.py`.
- `PermissionRequest` : `decision.behavior` = `allow` | `deny` ; `message` (raison donnée à Claude) et `interrupt` sont réservés à `deny`, `updatedInput` et `updatedPermissions` à `allow`. Un `allow` du hook ne passe pas outre une règle `deny`. Entrée : `tool_name`, `tool_input`, `permission_suggestions`, **sans `tool_use_id`** : l'id de `out/pending/` est donc un horodatage + aléa, et le seul lien avec le `PreToolUse` précédent est `tool_name` + `tool_input`.
- Les hooks héritent de l'environnement de `claude` (sauf `OTEL_*`, et les variables effacées si `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`).
- Les hooks des différents niveaux de réglages et des plugins **s'ajoutent** ; un même handler défini dans deux fichiers de réglages ne tourne qu'une fois, mais la copie d'un plugin reste séparée.
- `SessionEnd` : 1,5 s au total par défaut, et « les délais posés sur des hooks de plugin n'augmentent pas ce budget ». `reason` : `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
- `AskUserQuestion` passe par `PreToolUse` avec `tool_input.questions[]` (`question`, `header`, `options`, `multiSelect`) ; on peut y répondre par `updatedInput.answers` (piste pour ADR 0003, non testée ici).
- Statusline : `{"statusLine": {"type": "command", "command": "...", "padding"?: n, "refreshInterval"?: s}}`, lancée dans un shell, regroupée toutes les 300 ms ; un nouvel appel annule celui en cours.

## Ce que la doc laisse flou (c'est l'objet du prototype)

- Sortie 0 sans JSON sur `PermissionRequest` : la doc ne décrit ce cas que pour `PreToolUse` (« le flux normal continue ») et pour la sortie 2 sur `PermissionRequest`. → Q6.
- Hook tué au bout de son délai : la doc ne dit pas si la TUI affiche alors sa demande ou refuse. → scénario 3.
- Ce qu'affiche la TUI pendant qu'un hook `PermissionRequest` attend. → Q5.
- Si `--settings` est un niveau de réglages qui s'ajoute aux autres comme les fichiers (la doc parle de « user, project, local »). → Q2.
- Délai propre à la statusline : non documenté ; `statusline.py` coupe ta statusline à 2 s.
