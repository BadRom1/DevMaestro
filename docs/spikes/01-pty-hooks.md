# Prototype n° 1 : PTY, hooks injectés et permissions

- Objectif : confirmer ou invalider les [ADR 0002](../adr/0002-injection-des-hooks.md) et [ADR 0003](../adr/0003-permissions-depuis-l-app.md) avant d'écrire le vrai code.
- Outillage jetable : [`spikes/01-pty-hooks/`](../../spikes/01-pty-hooks/) (Python, bibliothèque standard uniquement).
- Durée visée : une demi-journée.
- Coût : quelques sessions courtes sur le profil perso, une sur le profil boulot.

## Questions

| N° | Question | Décision concernée |
|---|---|---|
| Q1 | Les hooks d'un plugin passé par `--plugin-dir` s'exécutent-ils **en plus** de ceux de l'utilisateur (peon-ping sonne-t-il toujours) ? | ADR 0002 |
| Q2 | Et des hooks passés par `--settings` : s'ajoutent-ils ou remplacent-ils ? (solution de repli) | ADR 0002 |
| Q3 | Les variables d'environnement du processus `claude` (`ORCH_TOKEN`…) sont-elles visibles par les hooks ? `session_id` vaut-il bien l'UUID passé à `--session-id` ? | ADR 0002 |
| Q4 | La statusline passée par `--settings` reçoit-elle les champs attendus (`context_window.used_percentage`, `cost.total_cost_usd`, `rate_limits`…) et peut-on chaîner la statusline de l'utilisateur ? | ADR 0002 |
| Q5 | Pendant qu'un hook `PermissionRequest` attend : que montre la TUI, reste-t-elle utilisable ? | ADR 0003 |
| Q6 | Une sortie sans décision fait-elle apparaître la demande de la TUI ? Que se passe-t-il au bout du délai ? | ADR 0003 |
| Q7 | Un hook `PreToolUse` avec le matcher `AskUserQuestion` se déclenche-t-il, et avec quel `tool_input` ? | ADR 0003 |
| Q8 | Les textes multi-lignes envoyés en *bracketed paste* dans le PTY arrivent-ils en un seul message ? | architecture § 9 |
| Q9 | Shift+Tab envoyé dans le PTY change-t-il le mode, et le `permission_mode` du hook suivant le reflète-t-il ? | architecture § 9 |
| Q10 | Avec `CLAUDE_CONFIG_DIR=~/.claude-work`, tout fonctionne-t-il pareil (et sur quel compte part la session) ? | architecture § 5 |
| Q11 | Quels événements arrivent, dans quel ordre, pour un tour simple, une permission, une question, une interruption, une fin de session ? | machine à états § 5.1 |
| Q12 | (ajoutée le 2026-10-19) `SubagentStart` / `SubagentStop` se déclenchent-ils en mode interactif, avec quels champs ? Les hooks d'un sous-agent portent-ils `agent_id` / `agent_type` ? Chaque sous-agent a-t-il son transcript ? | Suivi des sous-agents (architecture § 5) |

## Outillage

| Fichier | Rôle |
|---|---|
| `plugin/` | Plugin Claude Code minimal : déclare tous les événements utiles, chacun appelle `relay.py`. |
| `relay.py <événement>` | Journalise le JSON reçu (+ présence de `ORCH_TOKEN`) dans `out/events.jsonl`. Pour `PermissionRequest`, attend une décision posée par `decide.py`. |
| `decide.py` | Liste les permissions en attente et y répond : `allow`, `deny` ou `terminal` (sortie sans décision). |
| `statusline.py` | Journalise le JSON de la statusline dans `out/statusline.jsonl`, puis exécute la statusline de l'utilisateur et affiche sa sortie. |
| `ptyhost.py` | Lance `claude` dans un PTY relié au terminal courant, et accepte des commandes sur une FIFO : coller un texte en *bracketed paste*, envoyer Shift+Tab. |
| `inject.py` | Écrit ces commandes dans la FIFO. |
| `run.sh` | Lance une session de test avec les bons drapeaux (`--session-id`, `--plugin-dir`, `--settings`, profil, variante « hooks dans `--settings` »). |

Les événements journalisés serviront de jeux de test à la machine à états.

## Déroulé

Chaque scénario se lance avec `run.sh`, dans un terminal, pendant qu'un second terminal sert à `decide.py` / `inject.py` et à suivre `out/events.jsonl`.

1. **Tour simple** (Q1, Q3, Q4, Q11). Prompt : « Dis bonjour ». Vérifier peon-ping, l'ordre des événements, le `session_id`, `ORCH_TOKEN`, la statusline.
2. **Permission répondue depuis l'extérieur** (Q5, Q6). Mode `default`, prompt qui lance une commande Bash non autorisée. Observer la TUI pendant l'attente, puis `decide.py allow`. Recommencer avec `deny`, puis avec `terminal`.
3. **Délai dépassé** (Q6). Même scénario avec un délai de hook réduit (`SPIKE_HOOK_TIMEOUT=20`), sans répondre.
4. **Question de Claude** (Q7). Prompt qui pousse Claude à poser une question à choix (« Demande-moi avec l'outil AskUserQuestion si je préfère A ou B »).
5. **Coller et changer de mode** (Q8, Q9). Via `inject.py` : un texte de 5 lignes, puis Shift+Tab ×2, puis un prompt.
6. **Hooks dans `--settings`** (Q2). `run.sh --variant settings-hooks` : vérifier si peon-ping sonne encore.
7. **Profil boulot** (Q10). `run.sh --profile work`, tour simple.
8. **Fin de session** (Q11). `/exit`, puis Ctrl+C sur une autre session : regarder `SessionEnd` et son `reason`.

## Résultats

Relevés le 2026-10-19 avec Claude Code 2.1.303 (profils perso et boulot, comptes Max). Non testés : sortie du relais sans décision et dépassement du délai (Q6), devenus secondaires.

| N° | Résultat | Conséquence |
|---|---|---|
| Q1 | ✅ Les hooks du plugin et ceux de l'utilisateur s'exécutent ensemble : peon-ping a enregistré la session `568e8a35` dans son état (`~/.claude/hooks/peon-ping/.state.json`). | ADR 0002 confirmé. |
| Q2 | ✅ Les hooks passés par `--settings` s'ajoutent aussi (peon-ping a vu la session `a747e51d`). Une demande de confiance du dossier est apparue, mais un `git init` venait d'être fait : la cause (hooks dans `--settings` ou nouveau dépôt) reste incertaine. | Le plugin reste la voie principale ; `--settings` est un repli viable. |
| Q3 | ✅ `ORCH_TOKEN` visible et correct dans chaque hook ; `session_id` = l'UUID passé à `--session-id` (scénario 1, 2026-10-19). | Corrélation par `--session-id` + jeton validée. |
| Q4 | ✅ Statusline reçue avec `context_window.used_percentage`, `context_window_size` (1 M), `cost.total_cost_usd`, `model`, `effort`, `session_name`, `prompt_cache`, et **`rate_limits.five_hour` / `seven_day`** (compte Max, CLI 2.1.303). Le chaînage vers `bash ~/.claude/statusline-command.sh` fonctionne : la statusline de l'utilisateur s'affiche normalement en bas de la TUI. | L'adaptateur de quotas officiel suffit sur ce compte ; l'endpoint non documenté reste un repli. |
| Q5 | ✅ **La TUI affiche sa propre demande en parallèle** pendant que le hook attend (« Do you want to proceed? » avec 4 options, dont « switch to auto mode »). La TUI reste utilisable. La première réponse gagne : au premier essai (11:32), l'utilisateur a répondu dans la TUI (option « switch to auto mode ») et la décision `allow` arrivée 61 s plus tard a été ignorée. Une `Notification` `permission_prompt` arrive environ 6 s après `PermissionRequest`. | L'app et la TUI sont deux canaux concurrents, pas un canal et un repli. Le démon retire la demande dès qu'un `PostToolUse` (même `tool_name` + `tool_input`), un `Stop` ou un `UserPromptSubmit` arrive. ADR 0003 révisé. |
| Q6 | ✅ (partiel) Une décision `allow` venue de l'extérieur **ferme la demande affichée dans la TUI** et la commande s'exécute (`PostToolUse` 70 ms après). Sortie sans décision et dépassement du délai : pas encore testés, devenus secondaires puisque la TUI affiche déjà sa demande. | Répondre depuis l'app fonctionne. |
| Q7 | ✅ `PreToolUse` **et** `PermissionRequest` se déclenchent pour `AskUserQuestion`, avec `tool_input.questions[]` (question, header, options label/description, multiSelect). La TUI affiche la question en parallèle. Un `allow` seul ne répond pas. Un `allow` avec `updatedInput` = `tool_input` + `answers: {"<question>": "<label>"}` **répond à la question** : la TUI affiche « User answered Claude's questions » et Claude reçoit le choix. | L'app répond aux questions sans simuler de touches. ADR 0003 point 5 révisé. |
| Q8 | ✅ Un texte de 5 lignes collé en *bracketed paste* reste groupé (« [Pasted text #1 +4 lines] ») et ne part qu'à l'Entrée. ⚠ Claude Code l'encadre dans une balise `<pasted_content>` : Claude traite ce contenu comme venant d'ailleurs et peut ne pas suivre les consignes qu'il contient. | La consigne est tapée, seul le contenu (revue, sortie de tests, dictée) est collé. Architecture § 9 mise à jour. |
| Q9 | ✅ Cycle de Shift+Tab : `manual` → `accept edits` → `plan` → `auto` → `manual` (affiché en bas de la TUI, environ 1 s pour s'afficher). Le `permission_mode` du hook suivant vaut `default` pour `manual`. | Changer de mode depuis l'app est faisable : nombre de Shift+Tab calculé depuis le mode courant, puis vérification. |
| Q10 | ✅ `CLAUDE_CONFIG_DIR=~/.claude-work` : tout fonctionne pareil. Transcript dans `~/.claude-work/projects/`, quotas propres au compte (5 h à 15 % contre 2 % en perso). La confiance du dossier est enregistrée par profil (redemandée au premier lancement). | Profils validés ; l'app doit prévoir la demande de confiance au premier lancement d'un projet dans un profil. |
| Q11 | Tour simple : `SessionStart` (source `startup`) → `UserPromptSubmit` (+ 0,5 s) → `Stop` (+ 2,3 s). `permission_mode` vaut `default` quand on lance avec `--permission-mode manual`. `Notification` de type `idle_prompt` environ 60 s après `Stop` (11:31:15 → 11:32:15). | Fin par `/exit` et par double Ctrl+C : `SessionEnd` avec `reason=prompt_input_exit` dans les deux cas. Avec permission : `PreToolUse` → `PermissionRequest` (+ 0,3 s) → `Notification` `permission_prompt` (+ 6 s) → `PostToolUse` → `Stop`. | Jeux d'événements réels disponibles pour tester la machine à états. |
