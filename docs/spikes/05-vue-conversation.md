# Prototype n° 5 : vue conversation

- Objectif : savoir si l'on peut afficher une session comme une conversation, à la manière de Claude Desktop (fil de messages avec une vraie typographie, appels d'outils repliables, questions intégrées), **en gardant le vrai `claude` interactif** dans son PTY. La vue terminal reste disponible dans un onglet.
- Demande de l'utilisateur après le troisième essai de la v0.1 (2026-10-20). Cœur prévu de la v0.2.
- Outillage jetable : `spikes/05-vue-conversation/`.

## Deux voies

| Voie | Principe | Pour | Contre |
|---|---|---|---|
| **A. Transcript en direct** (piste principale) | Le vrai `claude` tourne dans son PTY ; le démon suit son transcript `.jsonl` au fil de l'eau et le front le dessine. La saisie part dans le PTY (collage + Entrée). | Garde la TUI d'origine, les commandes, les hooks, les ADR 0001 à 0003. | Format interne à Claude Code, qui peut changer ; pas de texte « en cours d'écriture » si le transcript n'est écrit qu'à la fin d'un message. |
| B. Mode programmatique | `claude -p --input-format stream-json --output-format stream-json` ou Agent SDK, comme Claude Desktop. | Flux structuré, texte en streaming. | Plus de TUI ni de slash commands interactives ; contredit l'ADR 0002 ; comportement différent de la session que l'utilisateur connaît. |

La voie B n'est étudiée que si la voie A échoue.

## Questions (voie A)

| N° | Question |
|---|---|
| Q1 | Quand une entrée est-elle écrite dans le transcript ? Délai entre l'affichage dans la TUI et l'écriture dans le `.jsonl`, pour un texte de Claude, un appel d'outil, un résultat, une question. Le texte est-il écrit au fil de l'eau ou seulement à la fin du message ? |
| Q2 | Quels types d'entrées et de blocs existent (message utilisateur, texte, réflexion, `tool_use`, `tool_result`, résumé de compaction, pièces jointes, méta), avec quels champs ? Lesquels faut-il pour reconstituer fidèlement la conversation ? |
| Q3 | Les sous-agents écrivent-ils dans des fichiers séparés, et comment les rattacher au message parent ? (Rejoint la Q12 du prototype n° 1.) |
| Q4 | Que se passe-t-il au `/clear`, à la compaction, au `--resume` (nouveau fichier ? suite du même ?) ? |
| Q5 | Saisie depuis un champ de l'app : la consigne tapée puis collée (règle du prototype n° 1, Q8) arrive-t-elle comme un prompt normal ? Slash commands, images collées ? |
| Q6 | Quoi montrer pendant que Claude écrit, si le texte n'arrive qu'à la fin : indicateur « Claude écrit… » à partir des hooks et de l'activité du PTY ? |
| Q7 | Coût du suivi : lecture incrémentale d'un fichier qui grossit (inotify), taille des transcripts réels, rendu d'une longue conversation (virtualisation). |
| Q8 | Stabilité du format : comparer des transcripts de plusieurs versions de Claude Code présentes sur le poste. |

## Outillage

- Réutiliser `spikes/01-pty-hooks/run.sh` et `ptyhost.py` (capture brute horodatée du PTY) pour lancer une vraie session.
- Un petit outil qui suit le transcript de la session (inotify), horodate chaque entrée à l'écriture, et produit :
  - un journal `entrée ↔ instant` comparable aux horodatages du PTY et des hooks ;
  - un inventaire des types d'entrées et de blocs rencontrés ;
  - un rendu HTML statique de la conversation, pour juger de la fidélité.
- Analyse en lecture seule des transcripts existants de l'utilisateur (types, tailles, versions), sans jamais en copier le contenu dans le dépôt.

## Scénarios

1. Tour simple avec un texte long (le texte arrive-t-il par morceaux ?).
2. Tour avec lectures de fichiers, une commande Bash et une modification.
3. Question `AskUserQuestion` et permission.
4. Sous-agent lancé par l'outil `Agent`.
5. `/clear` puis nouveau prompt ; `/compact`.
6. Prompt envoyé depuis un champ externe (collage + Entrée).

## Critères de décision

- **Fidélité** : tout ce qui compte dans la TUI se retrouve dans le transcript (texte, outils, résultats, questions), à l'exception des dialogues éphémères déjà couverts par les hooks.
- **Délai** : une entrée apparaît dans la vue moins d'une seconde après la TUI, ou un indicateur d'écriture comble l'attente.
- **Robustesse** : un champ inconnu ou un type d'entrée nouveau n'empêche pas l'affichage (rendu de repli).
- Si ces critères tiennent : vue conversation en v0.2 par la voie A, avec un ADR. Sinon : étudier la voie B.

## Résultats

À remplir.
