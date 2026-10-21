# Prototype n° 6 : plugins en processus séparé et graphe de code

- Date : 2026-10-21
- Question : comment un plugin tiers peut-il tourner à côté d'`orchd` sans affaiblir ses garanties, et quel outil de graphe de code peut servir de premier cas ?
- Outillage : jetable, hors du dépôt (dossier de travail de la session) ; rien n'a été installé dans la configuration de l'utilisateur, aucun installeur d'outil n'a été lancé.
- Décision qui en découle : [ADR 0007](../adr/0007-plugins.md).

## 1. Outils de graphe de code (faits vérifiés le 2026-10-21)

L'architecture § 19 contenait des faits périmés : corrigés ici.

| | CodeGraph | Graphify | Graphicle | GitNexus |
|---|---|---|---|---|
| Paquet | npm `@colbymchenry/codegraph` 1.6.2 (2026-10-03) | PyPI `graphifyy` 0.9.93 (2026-10-20) ; l'homonyme npm est sans rapport | binaires GitHub v0.1.3 (2026-10-21), pas sur crates.io | npm `gitnexus` 1.6.12 |
| Licence | MIT | **Apache-2.0** (depuis le 2026-07-22, plus MIT) | Apache-2.0 | **PolyForm Noncommercial** |
| Appel | CLI `--json`, bibliothèque (Node ≥ 22.5), MCP | CLI sur `graph.json`, MCP en option | CLI, MCP, HTTP 127.0.0.1 | CLI, MCP, HTTP |
| Impact d'un diff | pas direct : `affected` ne rend que les tests touchés ; `impact <symbole> --depth` par symbole, profondeur à recalculer depuis les arêtes | seulement `prs <n>` via `gh` | seulement par PR via `gh` | `detect_changes` |
| Réseau, télémétrie | télémétrie **active par défaut** (`telemetry.getcodegraph.com`) : `DO_NOT_TRACK=1` la coupe avec la vérification de version ; `CODEGRAPH_NO_DAEMON=1`, `CODEGRAPH_NO_DOWNLOAD=1` | aucune télémétrie ; journal des requêtes (`GRAPHIFY_QUERY_LOG_DISABLE=1`) ; LLM choisi selon les clés présentes (`GRAPHIFY_BACKEND=none`, `--code-only`) | vérification de version quotidienne (`GRAPHICLE_NO_UPDATE_NOTIFIER=1`) | — |
| Installeur | `install` écrit la config MCP, `CLAUDE.md`/`AGENTS.md`, des permissions de Claude Code : **facultatif** | `install` pose une skill et des hooks : facultatif | `setup` écrit `.mcp.json`, hooks, `AGENTS.md` : facultatif | — |

## 2. Essai de CodeGraph sur le dépôt

Sur un clone du dépôt, `HOME` et `XDG_*` redirigés, télémétrie, démon et téléchargement coupés : aucun effet de bord dans le dossier personnel.

- Indexation : 7 s (355 fichiers, 10 050 nœuds, 36 665 arêtes), pic à 1,1 Go ; base de 42 Mo ; resynchronisation après une modification : 1,35 s ; requête : 0,3 à 0,4 s.
- Installé, il pèse **288 Mo** (il embarque son propre Node).
- TypeScript bien couvert ; **Rust mal couvert** : les appels qualifiés vers un autre module (`launch::build_runner`…) et ceux des `mod tests` ne sont pas résolus.
- Il crée `.codegraph/` dans le worktree, qui apparaît dans `git status` : à exclure (`.git/info/exclude`).

## 3. Plugin en processus séparé

Un plugin de référence en Python (JSON-RPC 2.0, une ligne JSON par message, comme le transport stdio de MCP) et un hôte Rust jetable (tokio) qui le lance dans un scope systemd utilisateur, avec l'environnement filtré des runners.

| Cas | Résultat |
|---|---|
| nominal | `initialize` ~40 ms, rendu d'un panneau ~270 ms |
| plugin bloqué | délai par requête (5 s), arrêt du scope |
| sortie inondée, ligne de 50 Mo sans fin de ligne | refus en 1 à 90 ms, plugin arrêté |
| plantage | fermeture détectée immédiatement |
| 6 Mo sur stderr | aucun blocage (stderr vidé en continu, 4 Kio gardés) |
| petit-enfant détaché | supprimé avec le scope |
| plugin qui ignore SIGTERM | 2 s (voir piège 1) |

Pièges :

1. `systemctl --user stop` attend 90 s avant SIGKILL quand le plugin ignore SIGTERM : arrêter par `kill --signal=SIGTERM`, une seconde, puis `SIGKILL`.
2. Le scope est indispensable : un petit-enfant détaché échappe au groupe de processus.
3. Une ligne non JSON sur stdout désynchronise le protocole (une réponse peut être prise pour une autre) : toute ligne invalide arrête le plugin, sans reprise.
4. stderr doit être vidé, sinon le tube se remplit et le plugin se bloque.
5. Chaque requête a son délai ; les réponses sont associées par `id`, une tâche par plugin.
6. Le filtre des runners retire `DEVMAESTRO_*` : la configuration passe par `initialize`. Pour du code tiers, une **liste d'autorisation** (`PATH`, `HOME`, `LANG`, `XDG_RUNTIME_DIR`…) vaut mieux qu'une liste de retraits.

## 4. Interface d'un plugin

- La page n'accepte aujourd'hui que l'aperçu web en sous-cadre (`frame-src` localhost, `frameGuard.ts`) ; le preload n'est pas chargé dans les sous-cadres et l'IPC refuse tout cadre autre que le principal.
- **Port localhost** : marcherait sans changement, mais ouvre un port (contraire à « aucun port réseau ») joignable par tout processus local : exclu.
- **Protocole personnalisé** (`protocol.handle`, iframe `sandbox="allow-scripts"` sans `allow-same-origin`, pont `postMessage` validé) : possible, mais du code tiers s'exécute dans la page (CPU, mémoire), peut imiter les dialogues de l'app, et le thème, les contrastes, le clavier et la langue n'y sont plus garantis.
- **Rendu déclaratif** : le plugin renvoie des documents typés (tableau, liste, arbre, clés-valeurs, Markdown restreint, actions) que l'app valide et affiche elle-même. Aucun code tiers dans la page ; seule limite : pas de visualisation libre (le `graph.html` de Graphify).
