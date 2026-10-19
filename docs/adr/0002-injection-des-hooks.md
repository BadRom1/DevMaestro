# ADR 0002 : nos hooks arrivent par un plugin, la statusline est chaînée

- Statut : accepté sous réserve du [prototype n° 1](../spikes/01-pty-hooks.md) (2026-10-19)
- Voir aussi : [architecture § 6 et § 7](../architecture.md#6-sources-de-données-par-ordre-de-confiance)

## Contexte

L'état des sessions vient des hooks de Claude Code et des données reçues par la statusline. L'app doit les brancher sur chaque session qu'elle lance, sans modifier les fichiers de configuration de l'utilisateur.

Claude Code accepte au lancement `--settings <fichier ou JSON>` et `--plugin-dir <dossier>`. La documentation ne dit pas si des hooks passés par `--settings` **s'ajoutent** à ceux de l'utilisateur ou les **remplacent**. Or L'utilisateur utilise peon-ping en hook : s'il était remplacé, toutes les sessions lancées par l'app deviendraient muettes.

## Décision

1. **Les hooks sont fournis par un plugin Claude Code** généré par `orchd` et passé avec `--plugin-dir`. Il déclare : `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`. Chaque hook appelle `orchd hook <événement>`.
2. **La statusline est passée par `--settings`** et pointe sur `orchd statusline`. Ce relais transmet le JSON au démon, puis exécute la statusline configurée par l'utilisateur dans son profil et affiche sa sortie. L'utilisateur garde sa statusline.
3. **Corrélation** : l'app choisit l'identifiant avec `--session-id <uuid>` ; il revient dans le champ `session_id` de chaque hook. `ORCH_SOCKET` et `ORCH_TOKEN` sont passés dans l'environnement du processus `claude`.
4. **Reprise** : `--plugin-dir` et `--settings` sont repassés à chaque `--resume`, Claude Code ne les restaure pas.
5. Les hooks non bloquants envoient leur événement sans attendre (`SessionEnd` ne dispose que de 1,5 s).

## Ce que le prototype n° 1 doit confirmer

- Les hooks du plugin s'exécutent **en plus** de ceux de l'utilisateur (peon-ping sonne toujours). La documentation des hooks l'indique (les hooks des différents niveaux de réglages et des plugins s'additionnent) ; reste à le constater.
- Les variables d'environnement du processus `claude` sont visibles par les hooks.
- La statusline passée par `--settings` remplace bien celle de l'utilisateur, et le chaînage fonctionne.

## Alternatives écartées

- **Hooks dans `--settings`.** Gardé comme solution de repli si les plugins ne s'ajoutent pas, à condition que `--settings` fusionne.
- **Modifier `~/.claude/settings.json`.** Touche à la configuration de l'utilisateur et affecte aussi les sessions lancées hors de l'app. Écarté, sauf en option explicite pour suivre ces sessions-là.
- **Analyser le flux du terminal.** Fragile, change à chaque version de la TUI.
- **Agent SDK / mode headless.** Données propres, mais ce n'est plus la TUI d'origine.

## Conséquences

- Le plugin fait partie de l'app et doit suivre l'évolution des événements de hooks de Claude Code.
- Si le prototype montre que les hooks se remplacent au lieu de s'ajouter, cet ADR est révisé avant toute ligne de code.
