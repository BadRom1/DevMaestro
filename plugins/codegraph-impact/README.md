# Plugin `codegraph-impact` : impact du diff

Plugin de référence de DevMaestro (lot 22a, [ADR 0007](../../docs/adr/0007-plugins.md)). Il ajoute à chaque session un onglet « Impact » qui montre, à partir du diff de la session :

- les **symboles touchés** (fonctions, méthodes, classes… dont les lignes ont changé depuis la base du diff) ;
- ce qui **en dépend**, jusqu'à la profondeur choisie, avec la confiance du lien (« heuristique » quand CodeGraph a deviné l'arête) ;
- les **tests affectés** ;
- une action « Envoyer l'impact à Claude », qui propose ce résumé en Markdown : rien n'est envoyé sans ton clic dans le dialogue de DevMaestro.

Le calcul est fait par [CodeGraph](https://github.com/colbymchenry/codegraph), la CLI que **tu installes toi-même**. Le plugin est un seul fichier Python 3 (bibliothèque standard), lancé par `python3 -I codegraph_impact.py`, sans accès réseau demandé.

## Prérequis : CodeGraph

```sh
npm install -g @colbymchenry/codegraph   # environ 288 Mo, Node embarqué
```

- Ni DevMaestro ni ce plugin n'installent ou ne mettent à jour CodeGraph.
- N'utilise **jamais** `codegraph install` pour ce plugin : cette commande écrit dans la configuration de tes agents (`CLAUDE.md`, MCP, permissions de Claude Code). Le plugin n'en a pas besoin.
- CodeGraph envoie de la télémétrie **par défaut**. Pour tes usages hors du plugin : `codegraph telemetry off`.

### Réseau coupé : ce que le plugin pose, et la preuve

À chaque appel, le plugin ajoute à son environnement les variables suivantes, toutes lues par CodeGraph 1.6.2 (vérifié dans ses sources livrées, `lib/dist/` du paquet `@colbymchenry/codegraph-linux-x64`, et `npm-shim.js`) :

| Variable | Où CodeGraph la lit | Effet |
|---|---|---|
| `DO_NOT_TRACK=1` | `telemetry/index.js`, `upgrade/update-check.js` | coupe la télémétrie (prioritaire sur tout) **et** la vérification de version |
| `CODEGRAPH_TELEMETRY=0` | `telemetry/index.js` | coupe la télémétrie (redondant, par précaution) |
| `CODEGRAPH_NO_UPDATE_CHECK=1` | `upgrade/update-check.js` | coupe la vérification de version (redondant) |
| `CODEGRAPH_NO_DAEMON=1` | `mcp/index.js` | pas de démon partagé (concerne le serveur MCP ; précaution) |
| `CODEGRAPH_NO_DOWNLOAD=1` | `npm-shim.js` | interdit au lanceur npm de télécharger le binaire s'il manque |
| `NO_COLOR=1` | sortie | pas de couleurs dans la progression |

Essai (2026-10-21, CodeGraph 1.6.2) : `init`, `sync`, `node --symbols-only`, `impact --json` et `affected --stdin --json` lancés sur un petit dépôt, avec un `HOME` vierge, dans un espace de noms sans réseau (`unshare -rn`), sous `strace -f -e trace=connect,sendto,sendmsg` :

- **avec** ces variables : **aucun** appel `connect`/`sendto`/`sendmsg` (pas même une résolution DNS) ;
- **sans** elles (témoin) : résolutions DNS vers `127.0.0.53:53` et, avec `CODEGRAPH_TELEMETRY_DEBUG=1`, `POST https://telemetry.getcodegraph.com/v1/events` tenté (échoué faute de réseau).

## Installation

```sh
mkdir -p ~/.config/devmaestro/plugins
ln -s <dépôt>/plugins/codegraph-impact ~/.config/devmaestro/plugins/codegraph-impact
```

Puis, dans DevMaestro : **Réglages → Plugins**, relis la commande, les permissions et l'empreinte, et accepte. Permissions demandées : `diff.read` (fichiers du diff), `worktree.read` (dossier de la session), `worktree.write` (l'index et la ligne d'exclusion git, ci-dessous), `claude.propose` (proposer le résumé à Claude). Pas `network`.

## Ce que le plugin écrit

- L'index, dans `<worktree>/.codegraph/` (environ 42 Mo pour le dépôt de DevMaestro), créé **à la demande** par le bouton « Indexer » (puis « Mettre à jour »), en arrière-plan, avec une progression dans l'onglet.
- Une ligne `/.codegraph/` ajoutée **une seule fois** à `<git-common-dir>/info/exclude` (le `.git/info/exclude` du dépôt principal, aussi pour un worktree lié), pour que l'index n'apparaisse pas dans `git status`. Aucun autre fichier n'est modifié.

Pour tout retirer : supprimer `.codegraph/` du worktree et la ligne de `info/exclude`.

## Limites

- **Rust mal couvert** par CodeGraph : les appels entre fichiers Rust sont souvent manqués ; l'onglet le rappelle quand le diff contient du `.rs`.
- Bornes d'un rendu : 40 symboles touchés, 1 000 lignes de tableau, 22 s de calcul, fin des appels tués comprise (au-delà, résultat partiel signalé) ; l'hôte coupe à 30 s.
- Un chemin ou un nom de symbole qui commence par `-` ou contient un caractère de contrôle n'est jamais passé à CodeGraph (il est ignoré et signalé) ; le symbole est passé après `--`.
- Si le worktree est un dépôt git et que la ligne d'exclusion ne peut pas être écrite, l'indexation est refusée.
- Les symboles touchés sont déduits des lignes modifiées (`git diff -U0` contre la base du diff) ; un fichier ajouté compte tous ses symboles. Les propriétés, imports et variables sont rattachés au symbole qui les contient.

## Configuration

Dans `plugin.json`, champ `config` :

- `codegraph` : chemin **absolu** de l'exécutable CodeGraph ; `null` (défaut) pour le chercher dans le `PATH`.
- `depth` : profondeur de l'impact, de 1 à 5 (2 par défaut).

Modifier le manifeste change son empreinte : DevMaestro désactive le plugin jusqu'à ce que tu l'acceptes de nouveau.

## Tests

```sh
python3 -m unittest discover -s plugins/codegraph-impact/tests -v
```

Les tests utilisent un faux `codegraph` (`tests/fake_codegraph.py`) qui rejoue des sorties réelles (`tests/fixtures/`). Essai réel facultatif avec ta CLI (sauté sinon) :

```sh
DEVMAESTRO_TEST_CODEGRAPH=/chemin/absolu/vers/codegraph python3 -m unittest discover -s plugins/codegraph-impact/tests -v
```
