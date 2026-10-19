# ADR 0003 : répondre aux permissions depuis l'app, avec repli sur le terminal

- Statut : accepté sous réserve du [prototype n° 1](../spikes/01-pty-hooks.md) (2026-10-19)
- Voir aussi : [architecture § 8](../architecture.md#8-permissions-et-questions)

## Contexte

Le premier besoin : voir d'un coup d'œil quelle session attend une réponse, et répondre sans aller chercher le bon terminal. La plupart des attentes sont des demandes de permission (« Puis-je lancer `go test ./...` ? »), le reste des questions de Claude.

Le hook `PermissionRequest` reçoit `tool_name` et `tool_input` et peut renvoyer `{"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow" | "deny"}}}`. Son délai par défaut est de 600 s. La documentation ne dit pas ce qu'affiche la TUI pendant que le hook attend.

## Décision

1. `orchd hook PermissionRequest` envoie la demande au démon et **attend la décision**. La session passe à « à répondre » et une notification part.
2. Dans l'app : **Autoriser**, **Toujours pour ce projet** (Autoriser + règle ajoutée dans la configuration du projet), **Refuser**, ou **Répondre dans le terminal**.
3. **Repli** : « Répondre dans le terminal », le dépassement du délai ou un démon injoignable font sortir le hook **sans décision**. Claude Code affiche alors sa propre demande dans la TUI. Le relais n'autorise jamais rien par défaut.
4. Une réponse donnée dans le terminal (après repli) est détectée par le hook suivant (`PostToolUse` ou `Stop`), qui fait sortir la session de l'état « à répondre ».
5. **Questions de Claude** (`AskUserQuestion`) : si un hook `PreToolUse` les voit passer, la question et ses options s'affichent dans l'app, et la réponse est envoyée au terminal par des touches. Sinon, l'app montre « Claude te pose une question » et ouvre le terminal.

## Ce que le prototype n° 1 doit confirmer

- La TUI reste-t-elle utilisable pendant que le hook attend ? Affiche-t-elle quelque chose ?
- Une sortie sans décision fait-elle bien apparaître la demande de la TUI ?
- Ce qui se passe au bout du délai (on le réduit pour le test).
- Un `PreToolUse` avec le matcher `AskUserQuestion` se déclenche-t-il, et avec quel `tool_input` ? La documentation indique qu'il reçoit `tool_input.questions[]` et que la réponse peut être fournie par `updatedInput.answers` : si c'est confirmé, l'app répond aux questions sans envoyer de touches, ce qui remplacerait le point 5.
- `PermissionRequest` ne reçoit pas de `tool_use_id` : le lien avec le `PreToolUse` précédent se fait par `tool_name` + `tool_input`.

## Alternatives écartées

- **Envoyer les touches de la TUI** (flèches, Entrée) pour répondre. Dépend de l'affichage exact de la TUI, casse à chaque version.
- **Toujours répondre dans le terminal.** Plus simple, mais rate le besoin principal.
- **Autoriser par défaut au bout du délai.** Dangereux : jamais.

## Conséquences

- Un hook peut rester bloqué jusqu'à 600 s : le relais doit gérer la fermeture de la session et la perte du démon pendant l'attente.
- « Toujours pour ce projet » écrit dans la configuration du projet : action visible, réversible, et confirmée dans l'app.
