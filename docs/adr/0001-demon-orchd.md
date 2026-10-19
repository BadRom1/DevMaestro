# ADR 0001 : un démon `orchd` porte les sessions, l'app en est cliente

- Statut : accepté (2026-10-19)
- Voir aussi : [architecture § 4](../architecture.md#4-processus)

## Contexte

Orchestrateur lance jusqu'à une dizaine de sessions Claude Code interactives, chacune dans son PTY, plus des runners (serveurs de dev, tests). Ces sessions durent des heures et contiennent du travail en cours.

Si les PTY appartiennent au processus de l'interface, fermer l'app, la mettre à jour ou la voir planter tue toutes les sessions. On veut aussi pouvoir, plus tard, piloter des sessions sur une machine distante (SSH).

## Décision

Un démon Rust, `orchd`, possède les PTY, l'état des sessions et la base SQLite. L'app Tauri est un client : elle se connecte à `orchd` par un socket Unix, affiche, et envoie les actions de l'utilisateur.

- `orchd` est démarré par l'app s'il ne tourne pas déjà.
- Il garde par PTY un émulateur de terminal sans affichage et un tampon, pour qu'une UI qui se reconnecte retrouve l'écran courant.
- Le relais des hooks et de la statusline est une sous-commande du même binaire (`orchd hook`, `orchd statusline`).
- Un seul workspace, deux crates : `core` (domaine, ports, adaptateurs, binaire `orchd`) et `app` (Tauri).
- Toute commande passe par une notion d'hôte (`local` en v1), pour accueillir un `orchd` distant plus tard.

## Alternatives écartées

- **Tout dans le processus de l'app.** Plus simple, mais fermer l'app tue les sessions. Rédhibitoire.
- **Déléguer à tmux.** Survit aux redémarrages, mais ajoute une dépendance, complique le flux d'octets vers xterm.js et ne règle rien pour l'état structuré.
- **Un crate par adaptateur.** Trop de découpage pour un seul domaine.

## Conséquences

- Il faut un protocole app ↔ démon (JSON-RPC + flux PTY) et gérer la reconnexion.
- Deux processus à superviser ; il faut un moyen simple d'arrêter le démon et de voir ses logs.
- Le futur mode SSH revient à faire tourner `orchd` à distance et à s'y connecter par un tunnel.
