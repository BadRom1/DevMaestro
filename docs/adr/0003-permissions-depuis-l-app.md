# ADR 0003 : répondre aux permissions depuis l'app, avec repli sur le terminal

- Statut : accepté, révisé après le [prototype n° 1](../spikes/01-pty-hooks.md) (2026-10-19)
- Voir aussi : [architecture § 8](../architecture.md#8-permissions-et-questions)

## Contexte

Le premier besoin : voir d'un coup d'œil quelle session attend une réponse, et répondre sans aller chercher le bon terminal. La plupart des attentes sont des demandes de permission (« Puis-je lancer `go test ./...` ? »), le reste des questions de Claude.

Le hook `PermissionRequest` reçoit `tool_name` et `tool_input` et peut renvoyer `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow" | "deny"}}}`. Son délai par défaut est de 600 s. La documentation ne dit pas ce qu'affiche la TUI pendant que le hook attend.

## Décision

> Révisée le 2026-10-19 après le prototype n° 1 : la TUI affiche sa propre demande **pendant** que le hook attend. L'app et le terminal sont deux canaux concurrents ; la première réponse gagne.

1. `orchd hook PermissionRequest` envoie la demande au démon et **attend la décision**. La session passe à « à répondre » et une notification part.
2. Dans l'app : **Autoriser**, **Toujours pour ce projet** (Autoriser + règle ajoutée dans la configuration du projet), **Refuser**. Une réponse de l'app ferme la demande affichée dans la TUI (constaté).
3. **Réponse dans le terminal** : toujours possible, la demande y est affichée en même temps. Le démon la détecte au hook suivant (`PostToolUse` avec le même `tool_name` + `tool_input`, `Stop` ou `UserPromptSubmit`), retire la demande de l'app et libère le relais sans décision.
4. Délai dépassé ou démon injoignable : le relais sort **sans décision**, la demande reste dans la TUI. Le relais n'autorise jamais rien par défaut.
5. **Questions de Claude** (`AskUserQuestion`) : `PreToolUse` et `PermissionRequest` reçoivent la question et ses options, qui s'affichent dans l'app. La réponse part par le `PermissionRequest` : `allow` avec `updatedInput` = `tool_input` + `answers: {"<question>": "<option>"}`. Aucune touche simulée (constaté au prototype n° 1).

## Ce que le prototype n° 1 doit confirmer

- La TUI reste-t-elle utilisable pendant que le hook attend ? Affiche-t-elle quelque chose ?
- Une sortie sans décision fait-elle bien apparaître la demande de la TUI ?
- Ce qui se passe au bout du délai (on le réduit pour le test).
- Un `PreToolUse` avec le matcher `AskUserQuestion` se déclenche-t-il, et avec quel `tool_input` ? La documentation indique qu'il reçoit `tool_input.questions[]` et que la réponse peut être fournie par `updatedInput.answers` : si c'est confirmé, l'app répond aux questions sans envoyer de touches, ce qui remplacerait le point 5.
- `PermissionRequest` ne reçoit pas de `tool_use_id` : le lien avec le `PreToolUse` précédent se fait par `tool_name` + `tool_input`.

## Alternatives écartées

- **Envoyer les touches de la TUI** (flèches, Entrée) pour répondre. Dépend de l'affichage exact de la TUI, casse à chaque version.
- **Toujours répondre dans le terminal.** Plus simple, mais rate le besoin principal.
- **Un bouton « Répondre dans le terminal » qui libère le hook.** Prévu dans la première version de cet ADR ; inutile puisque la TUI affiche déjà la demande.
- **Autoriser par défaut au bout du délai.** Dangereux : jamais.

## Conséquences

- Un hook peut rester bloqué jusqu'à 600 s : le relais doit gérer la fermeture de la session et la perte du démon pendant l'attente.
- « Toujours pour ce projet » écrit dans la configuration du projet : action visible, réversible, et confirmée dans l'app.
