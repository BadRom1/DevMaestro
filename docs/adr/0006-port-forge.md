# ADR 0006 : les forges (GitHub, GitLab…) passent par un port « forge » et la CLI de la forge

- Statut : accepté (2026-10-21)
- Modifie : la règle « seule connexion sortante : l'endpoint d'usage d'Anthropic » (CLAUDE.md, architecture § 2) : le démon peut lancer la CLI de la forge de l'utilisateur, qui, elle, va sur le réseau
- Voir aussi : [architecture § 19](../architecture.md) (plugins), [feuille de route](../feuille-de-route.md) (lots 13 et 16)

## Contexte

L'utilisateur veut lancer des sessions depuis des issues (une par sous-issue d'un epic), suivre ses demandes de fusion et leur CI, et relire une demande de fusion dans l'app. Il travaille sur GitHub ; d'autres utilisateurs seront sur GitLab, Gitea ou Bitbucket. Le projet promet jusqu'ici qu'aucune connexion sortante n'est ouverte hormis l'endpoint de quotas, et ne stocke aucun secret.

## Décision

1. **Un port `Forge` dans le domaine**, au vocabulaire neutre : dépôt distant, issue (avec ses sous-issues ou son epic), demande de fusion (PR ou MR), commentaire de revue ligne à ligne, état de la CI, capacités déclarées (une forge peut ne pas avoir de sous-issues, de revue par ligne…). L'interface ne parle que ce vocabulaire.
2. **Premier adaptateur : GitHub, par la CLI `gh` de l'utilisateur.** Le démon ne tient aucun jeton, n'ouvre aucune connexion lui-même et n'écrit aucune configuration : il lance `gh` (arguments séparés, jamais de shell, délais, sortie JSON bornée, environnement maîtrisé) dans le dossier du dépôt ; l'authentification, le proxy et l'hôte (github.com ou GitHub Enterprise) sont ceux de l'utilisateur. Si `gh` est absent ou non connecté, la fonction est indisponible avec un message clair, sans erreur bloquante.
3. **Choix de la forge par projet**, détecté à partir de l'URL du remote (`origin` par défaut), modifiable dans les réglages du projet ; désactivable globalement (réglage « Accès aux forges »). Rien n'est appelé tant que l'utilisateur n'ouvre pas une vue qui en a besoin.
4. **Chemin vers les plugins** : le contrat du port est écrit pour correspondre aux méthodes JSON-RPC qu'exposera un plugin de forge (architecture § 19). Quand l'hôte de plugins existera, l'adaptateur GitHub en sortira comme plugin de référence ; GitLab (`glab`) et les autres seront des plugins sur le même contrat.
5. **Écritures vers la forge** (commentaire de revue, création d'une demande de fusion…) : toujours à l'initiative explicite de l'utilisateur dans l'app, avec un aperçu de ce qui sera publié ; jamais déclenchées par Claude au travers de l'app.
6. **Données** : le contenu des issues et des demandes de fusion n'est pas journalisé ; il est gardé en mémoire avec une courte durée de vie, pas en base (seuls les liens session ↔ issue y sont enregistrés).

## Conséquences

- CLAUDE.md et l'architecture précisent la règle réseau : le démon n'ouvre lui-même qu'une connexion (quotas) ; il peut lancer la CLI de forge de l'utilisateur, à sa demande.
- Dépendance assumée au format JSON de `gh` (versionné par ses `--json` champs explicites) ; tests avec des sorties enregistrées et un faux `gh`.
- Le brouillon de revue gagne une destination (Claude ou la forge) quand la revue des demandes de fusion arrivera.
