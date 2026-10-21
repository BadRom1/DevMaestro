# DevMaestro

Application desktop open source pour suivre et piloter plusieurs sessions Claude Code : un démon Rust (`orchd`) porte les sessions dans des PTY, un front Electron les affiche. L'intelligence reste dans Claude Code.

## Où lire avant de coder

- `docs/architecture.md` : architecture complète ; `docs/adr/` : décisions (ne pas les contredire sans nouvel ADR).
- `docs/v0.1.md` : périmètre et lots de la version en cours.
- `docs/spikes/` : résultats des prototypes techniques ; `spikes/` : leur outillage jetable (ne pas en dépendre depuis le code produit).
- `spikes/01-pty-hooks/fixtures/` : événements de hooks et statusline réels, à rejouer dans les tests.

## Conventions

- Docs, commentaires et textes de l'interface en **français** avec tous les accents ; identifiants en anglais.
- Rust : un seul domaine, des modules dans `crates/core` (pas de crate par adaptateur). Le domaine ne dépend d'aucun adaptateur (ports dans `ports/`, implémentations dans `adapters/`).
- Ne jamais épingler une version de dépendance de mémoire : vérifier sur crates.io ou npm au moment de l'ajout.
- Ne jamais modifier la configuration Claude Code de l'utilisateur (`~/.claude*`) : tout passe par `--plugin-dir` et `--settings` au lancement.
- Aucun port réseau ouvert, aucune télémétrie ; le socket du démon n'est lisible que par l'utilisateur. Seule connexion sortante : l'endpoint d'usage d'Anthropic pour les quotas (jeton OAuth du profil lu, jamais écrit ni journalisé), désactivable par `[quotas] usage_api = false`. Les forges (GitHub, GitLab…) passent par la CLI de l'utilisateur (`gh`, `glab`), lancée par le démon à la demande de l'utilisateur, sans jeton tenu par l'app ([ADR 0006](docs/adr/0006-port-forge.md)). Un plugin accepté par l'utilisateur avec la permission `network` peut aller sur le réseau ; sans elle, il coupe la télémétrie des outils qu'il lance ([ADR 0007](docs/adr/0007-plugins.md)).

## Vérifications avant de rendre la main

- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` dans le workspace.
- Front : `pnpm typecheck`, `pnpm test`, `pnpm build` dans `app/`.
- Aucun test rouge, même hors de son propre changement.
