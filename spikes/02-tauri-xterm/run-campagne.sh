#!/usr/bin/env bash
# Campagne du 2026-10-19 : Tauri vs Chrome à 60 Hz (BenQ DP-3), puis Tauri à 165 Hz (portable).
# Chaque passage continue même si le précédent sort en erreur ; le journal liste les rapports produits.
cd "$(dirname "$0")"
commun=(--no-build --hidden-ipc off --batch-ms 16 --repeat 2)
journal=out/campagne-$(date +%Y%m%d-%H%M%S).log
for rate in 2 20; do
  ./run-bench.sh     "${commun[@]}" --monitor DP-3 --rate "$rate" 2>&1 | tail -1 | tee -a "$journal"
  ./run-bench-web.sh "${commun[@]}" --monitor DP-3 --rate "$rate" 2>&1 | tail -1 | tee -a "$journal"
done
./run-bench.sh --no-build --hidden-ipc off --batch-ms 16 --repeat 2 --monitor eDP-1 --rate 2 2>&1 | tail -1 | tee -a "$journal"
echo "Campagne terminée" | tee -a "$journal"
