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

À remplir pendant le prototype.

| N° | Résultat | Conséquence |
|---|---|---|
| Q1 | | |
| Q2 | | |
| Q3 | ✅ `ORCH_TOKEN` visible et correct dans chaque hook ; `session_id` = l'UUID passé à `--session-id` (scénario 1, 2026-10-19). | Corrélation par `--session-id` + jeton validée. |
| Q4 | ✅ Statusline reçue avec `context_window.used_percentage`, `context_window_size` (1 M), `cost.total_cost_usd`, `model`, `effort`, `session_name`, `prompt_cache`, et **`rate_limits.five_hour` / `seven_day`** (compte Max, CLI 2.1.303). Le chaînage vers `bash ~/.claude/statusline-command.sh` fonctionne : la statusline de l'utilisateur s'affiche normalement en bas de la TUI. | L'adaptateur de quotas officiel suffit sur ce compte ; l'endpoint non documenté reste un repli. |
| Q5 | Premier essai (11:32) : `PermissionRequest` à 11:32:31, puis `PostToolUse` **5 s plus tard** (commande exécutée) alors que le relais attendait encore ; la décision `allow` envoyée à 11:33:32 (61 s) n'a servi à rien. Le mode est passé de `default` à `auto` entre les deux. Hypothèse : la TUI affiche sa propre demande **en parallèle** du hook, et la première réponse l'emporte. À confirmer avec l'utilisateur (qu'a-t-il vu, qu'a-t-il tapé ?). | Si confirmé : l'app et la TUI sont en concurrence. Le démon doit annuler une demande en attente dès qu'un `PostToolUse` (même `tool_name` + `tool_input`) ou un `Stop` arrive. |
| Q6 | | |
| Q7 | | |
| Q8 | | |
| Q9 | | |
| Q10 | | |
| Q11 | Tour simple : `SessionStart` (source `startup`) → `UserPromptSubmit` (+ 0,5 s) → `Stop` (+ 2,3 s). `permission_mode` vaut `default` quand on lance avec `--permission-mode manual`. `Notification` de type `idle_prompt` environ 60 s après `Stop` (11:31:15 → 11:32:15). | Suite à compléter avec les autres scénarios. |
