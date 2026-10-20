# ADR 0005 : la vue conversation lit le transcript de Claude Code

- Statut : accepté (2026-10-20)
- Modifie : [architecture § 6](../architecture.md) (rang du transcript parmi les sources), [ADR 0002](0002-injection-des-hooks.md) (événement `PreCompact` ajouté au plugin)
- Voir aussi : [prototype n° 5](../spikes/05-vue-conversation.md), [prototype n° 1](../spikes/01-pty-hooks.md) (Q8, Q12), [ADR 0003](0003-permissions-depuis-l-app.md)

## Contexte

L'utilisateur veut lire une session comme une conversation (typographie, outils repliables, questions intégrées), à la manière de Claude Desktop, sans perdre le vrai `claude` interactif (ADR 0002). Le prototype n° 5 a comparé deux voies :

- **A** : le vrai `claude` reste dans son PTY ; le démon suit son transcript `.jsonl` et le front le dessine ;
- **B** : mode programmatique (`claude -p --input-format stream-json` ou Agent SDK), comme Claude Desktop.

Mesures (Claude Code 2.1.304, 3 sessions pilotées, 594 transcripts réels lus en statistiques seulement) :

- Le transcript est écrit **bloc par bloc, à la fin de chaque message d'API** : rien n'existe du texte en cours d'écriture ; une entrée complète (prompt, outil, résultat, question, texte de fin de tour) arrive en général moins d'une seconde après la TUI (1,4 s au pire mesuré).
- Tout ce qui compte s'y trouve : prompts (collages en entier), textes, outils et résultats (diff des `Edit`, réponses aux questions), sous-agents dans des fichiers séparés rattachés sans heuristique, compaction et `/clear`.
- `/clear` ouvre un nouveau fichier et un nouvel identifiant ; `/compact` et `--resume` continuent le même fichier.
- Format interne mais stable sur son cœur : 16 versions lues sans une ligne invalide ; chaque version ajoute des types optionnels.
- L'activité du PTY ne distingue pas « Claude écrit » de « Claude attend » ; les hooks donnent les bornes.

La voie B ne gagnerait que le texte en streaming, au prix de la TUI, des commandes interactives et de l'ADR 0002.

## Décision

1. **Voie A.** La vue conversation est construite à partir du **transcript**, suivi en direct par le démon (lecture incrémentale par décalage, reste de ligne partielle, jamais le mtime). Le transcript passe, pour cette vue, de source optionnelle à source principale ; **les hooks restent la seule source de l'état** de la session (statut, demandes, sous-agents).
2. **Lecture tolérante, sortie normalisée.** Le démon traduit le format interne de Claude Code en **entrées stables** (prompt, texte, réflexion, outil avec son résultat, question, sous-agent, notification, compaction, commande, erreur, inconnu) ; un type ou un champ inconnu donne une entrée « inconnu » affichée en repli, une ligne invalide est ignorée et comptée. Le front ne lit jamais le format brut.
3. **Le texte en cours d'écriture n'est pas montré par la vue conversation.** Un **indicateur d'activité** dérivé des hooks (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `Stop`, `PreCompact`, `SessionStart`) dit « Claude écrit », « outil X », « sous-agents », « compaction », avec le temps écoulé. Le terminal reste à un clic. Un aperçu des dernières lignes de l'écran (émulateur du démon, affichage seul) est permis plus tard, sans analyse de son contenu.
4. **Pas de nouvelle lecture de l'écran.** La seule exception reste la lecture du mode de permission dans le pied de la TUI (architecture § 6). La saisie depuis la vue conversation ne cherche donc pas à détecter le sondage ni la suggestion de prompt de la TUI : risque accepté (un chiffre tapé peut être avalé par un sondage après `/compact`), signalé dans l'interface, la vue terminal restant le recours.
5. **Saisie** : même règle que le prototype n° 1 (Q8) : texte court tapé, contenu multiligne collé en *bracketed paste*, puis Entrée ; jamais d'Entrée sur un champ vide ; refus pendant une demande ouverte (ADR 0003) ; pas de file d'attente côté app (Claude Code met déjà en file ce qu'on tape pendant qu'il travaille).
6. **ADR 0002 amendé** : le plugin généré déclare aussi `PreCompact`, seul signal d'une compaction en cours.
7. **Vie privée** : le contenu des transcripts ne sort pas de la machine (protocole local vers le front uniquement), n'est jamais journalisé, et le démon ne lit que les transcripts des sessions qu'il connaît.

## Conséquences

- Nouveau suivi de fichiers dans le démon (port distinct de la découverte des anciennes sessions), avec bascule de fichier au `SessionStart` (`clear`) et suivi des fichiers de sous-agents.
- Le protocole gagne une lecture paginée de la conversation et des notifications d'ajout ou de mise à jour d'entrées ; les gros contenus sont tronqués, lisibles en entier à la demande.
- Dépendance assumée à un format interne : fixtures par version de Claude Code et test de non-régression sur le cœur à chaque montée de version.
- Le texte long apparaît d'un bloc à la fin de sa génération : l'indicateur d'activité rend l'attente lisible.
