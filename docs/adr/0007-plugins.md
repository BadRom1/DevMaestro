# ADR 0007 : les plugins sont des processus séparés, à interface déclarative

- Statut : proposé (2026-10-21) ; le premier cas du lot 22a reste à choisir avec l'utilisateur
- Précise : [architecture § 19](../architecture.md) (piste « à concevoir ») ; s'appuie sur l'[ADR 0006](0006-port-forge.md) (port forge, injection de prompt) et le lot 14a (runners : lancement sans shell, scope, environnement filtré, empreinte acceptée)
- Prototype : [n° 6](../spikes/06-plugins.md)

## Contexte

Chacun doit pouvoir ajouter ses outils à DevMaestro : un graphe de code pour voir l'impact d'un diff (CodeGraph, Graphify, Graphicle), une forge autre que GitHub (GitLab par `glab`), l'API d'une équipe. Le projet tient des promesses fortes : aucun port réseau, aucune télémétrie, le démon seul sur ses sockets, rien d'écrit dans `~/.claude*`, le contenu tiers jamais tapé comme une consigne, une interface accessible (contrastes AA, clavier, palettes pour daltoniens) et traduite (lot 20). Un plugin est du code tiers : il ne doit affaiblir aucune de ces promesses.

## Décision

1. **Un plugin est un processus séparé**, dans n'importe quel langage, lancé et supervisé par `orchd`, jamais par l'app.
   - Transport : JSON-RPC 2.0 sur stdio, **une ligne JSON par message** (comme le transport stdio de MCP). Toute ligne invalide, trop longue (1 Mio) ou tout débordement arrête le plugin, sans reprise.
   - Lancement comme un runner : argv sans shell, scope systemd utilisateur `devmaestro-plugin-<nom>-<id>`, groupe de processus propre ; arrêt par SIGTERM puis SIGKILL au scope (jamais `systemctl stop`, qui attend 90 s).
   - Environnement par **liste d'autorisation** (`PATH`, `HOME`, `LANG`/`LC_*`, `XDG_RUNTIME_DIR`, `TERM`), pas par retraits ; la configuration passe par `initialize`.
   - Délai par requête, stderr vidé en continu (fin gardée pour le diagnostic), réponses associées par `id`.
   - **Aucun socket** : un plugin n'a que son stdio. Le socket de contrôle reste à l'app, le relais aux hooks ; le contrôle d'appartenance au scope les ferme aux `devmaestro-plugin-*`.
2. **Manifeste** `plugin.json` dans `~/.config/devmaestro/plugins/<nom>/` (installé par l'utilisateur ; rien n'est téléchargé par l'app) : nom, version, libellés `fr`/`en`, commande, version d'API, **contributions** et **permissions**.
   - Contributions de la v1 : un **onglet de session** (panneau), des **actions** (sur une session, un fichier, une demande de fusion), une **pastille** dans la barre latérale.
   - Permissions, liste fermée : lire le diff et les fichiers du worktree d'une session ; lire la liste des sessions ; proposer un contenu à envoyer à Claude ; **réseau**. Une permission non déclarée est refusée par le démon.
3. **Confiance par empreinte**, comme les runners du lot 15 : sha256 du manifeste et de l'exécutable (et des fichiers qu'il désigne). Le plugin reste inactif tant que l'utilisateur n'a pas accepté cette empreinte et ces permissions dans l'app ; toute modification redemande l'accord. L'acceptation est vérifiée par le processus principal d'Electron (comme `runnerGuard`) et par le démon.
4. **Interface déclarative.** Un plugin ne fournit ni HTML ni script : il renvoie des **documents typés** (tableau, liste, arbre, clés-valeurs, Markdown restreint, jauge, actions) que l'app valide et affiche avec ses propres composants. Le thème, les contrastes, le clavier, les lecteurs d'écran et la langue s'appliquent donc aux plugins. Tout texte d'un plugin est traité comme du contenu tiers (caractères invisibles et de direction retirés, Markdown sans HTML). Une iframe ne viendra qu'ensuite, comme capacité optionnelle d'un manifeste, par un protocole personnalisé sandboxé, après un prototype dédié ; **jamais par un port localhost**.
5. **Vers Claude, la règle de l'ADR 0006 sans exception.** Un plugin ne tape jamais rien dans une session. Il peut **proposer** un contenu ; l'envoi part d'un clic de l'utilisateur, la **consigne tapée** vient du registre des consignes (lot 18 : une entrée par action de plugin, modifiable) et le contenu du plugin est **collé** comme donnée.
6. **Réseau.** Un plugin qui déclare `network` peut aller sur le réseau (ce que le démon ne peut empêcher techniquement sans bac à sable plus lourd) : la permission est affichée en clair à l'acceptation, et la règle réseau de CLAUDE.md est précisée comme pour les forges. Un plugin sans `network` qui lance un outil connu pour appeler le réseau (télémétrie de CodeGraph…) doit le couper (`DO_NOT_TRACK=1`…) ; c'est vérifié pour les plugins livrés avec le dépôt.
7. **Capacité** `hello.capabilities.plugins` : un démon plus ancien n'en a pas, et l'app masque alors toute l'interface des plugins.
8. **Hors de la v1** : un plugin qui fournit aussi un plugin Claude Code (skills, MCP) injecté par `--plugin-dir` à côté du nôtre ; un dépôt de plugins ; les mises à jour automatiques.

## Premier lot (22a) : la plus petite tranche complète

L'hôte (manifeste, empreinte et acceptation, processus supervisé, onglet déclaratif, une action « envoyer à Claude ») et **un** plugin de référence dans le dépôt (`plugins/`, écrit dans un autre langage que TypeScript pour prouver l'indépendance du langage). Deux candidats pour ce premier cas :

- **Impact du diff par CodeGraph** (MIT, 7 s d'indexation sur ce dépôt, sortie JSON exploitable, sans son installeur). À dire franchement : 288 Mo à installer par l'utilisateur, un index de 42 Mo par worktree à exclure de git, une couverture du Rust faible ; et pas de commande « diff → symboles touchés » : le plugin compose `node --symbols-only` puis `impact` et recalcule les profondeurs.
- **Forge GitLab par `glab`**, derrière le port `Forge` existant : valide le chemin promis par l'ADR 0006 (point 4), mais demande que les panneaux de la forge puissent être servis par un plugin.

L'API d'une équipe sera le troisième cas, à concevoir avec son équipe.

## Conséquences

- Le système de plugins vit dans `crates/core` (port `PluginHost`, adaptateur processus) et dans `app/` (validation des documents, rendu, acceptation) ; pas de nouvelle crate.
- Les documents déclaratifs limitent ce qu'un plugin peut montrer (pas de visualisation libre comme `graph.html`) : c'est le prix de la sécurité et de l'accessibilité ; l'iframe sandboxée reste ouverte pour plus tard.
- La règle réseau de CLAUDE.md et l'architecture § 2 et § 19 seront mises à jour quand l'ADR sera accepté.
- Risque résiduel : un plugin accepté avec `network` peut faire fuir ce qu'il lit (diff, fichiers). L'acceptation montre ce qu'il demande ; le reste relève de la confiance de l'utilisateur dans le code qu'il installe, comme pour une extension d'éditeur.
