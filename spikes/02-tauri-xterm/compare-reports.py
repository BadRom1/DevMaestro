#!/usr/bin/env python3
"""Compare deux rapports du banc (JSON), par exemple WebKitGTK contre Chromium.

Usage : ./compare-reports.py out/report-A.json out/report-B.json
Affiche les mesures clés côte à côte par scénario × moteur, et signale les écarts de conditions
(densité de pixels, colonnes×lignes, fréquence d'images, débit, source, lots, mode IPC, front, écran).
Code de sortie : 0 conditions identiques, 2 écarts de parité, 1 erreur de lecture.
"""

import json
import sys

METRICS = [
    ("frames_p95", "images p95 (ms)"),
    ("frames_over33_pct", "images > 33 ms (%)"),
    ("echo_p95", "frappe p95 (ms)"),
    ("cpu_pct", "CPU (% cœur)"),
    ("switch_p95", "changement p95 (ms)"),
    ("drain_ms", "pic : file → vide (ms)"),
    ("integrity_pct", "octets reçus (%)"),
    ("msgs_per_s", "messages/s"),
    ("backend_us_per_msg", "µs backend / msg"),
    ("browser_us_per_msg", "µs moteur web / msg"),
]

PARITY = [
    ("device_pixel_ratio", "devicePixelRatio"),
    ("terminals_single", "terminaux S1–S3 (col×lig)"),
    ("terminals_grid", "terminaux S4 (col×lig)"),
    ("refresh_hz_estimate", "fréquence d'images estimée (Hz)"),
    ("rate_kbps", "débit par session (Ko/s)"),
    ("source", "source du flux"),
    ("batch_ms", "lots (ms)"),
    ("hidden_ipc", "sessions cachées sur le transport"),
    ("dist_hash", "empreinte du front"),
    ("monitor", "écran demandé"),
    ("monitor_reached", "écran atteint"),
]


def same(key, a, b):
    if key == "refresh_hz_estimate" and a and b:
        return abs(a - b) / max(a, b) < 0.05
    if key == "dist_hash" and isinstance(a, str) and isinstance(b, str):
        return a.split()[0] == b.split()[0]  # l'origine (embarqué / servi) peut différer
    return a == b


def fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.1f}"
    return str(v)


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip())
        return 1
    try:
        a, b = (json.load(open(p, encoding="utf-8")) for p in sys.argv[1:3])
    except (OSError, ValueError) as e:
        print(f"lecture impossible : {e}")
        return 1
    la, lb = (r.get("engine", "?") for r in (a, b))
    print(f"A : {sys.argv[1]}\n    {la} — {a.get('transport', '?')} — verdict {a['conclusion']['verdict']}")
    print(f"B : {sys.argv[2]}\n    {lb} — {b.get('transport', '?')} — verdict {b['conclusion']['verdict']}\n")

    print("## Conditions\n")
    gaps = 0
    pa, pb = a.get("parity", {}), b.get("parity", {})
    for key, label in PARITY:
        va, vb = pa.get(key), pb.get(key)
        ok = same(key, va, vb)
        gaps += not ok
        print(f"{'  ' if ok else '⚠ '}{label} : {fmt(va)} | {fmt(vb)}{'' if ok else '   ← ÉCART'}")
    for name, r in (("A", a), ("B", b)):
        if r.get("partial"):
            gaps += 1
            print(f"⚠ rapport {name} partiel")

    print("\n## Mesures (médianes ; A | B ; * = case invalide)\n")
    cells_b = {(c["scenario"], c["renderer"]): c for c in b.get("cells", [])}
    for ca in a.get("cells", []):
        k = (ca["scenario"], ca["renderer"])
        cb = cells_b.pop(k, None)
        print(f"{k[0]} · {k[1]}{' *A' if not ca['valid'] else ''}{' *B' if cb and not cb['valid'] else ''}")
        for key, label in METRICS:
            va = ca["metrics"].get(key, {}).get("median")
            vb = cb["metrics"].get(key, {}).get("median") if cb else None
            if va is None and vb is None:
                continue
            print(f"    {label:24} {fmt(va):>9} | {fmt(vb):<9}")
    for k in cells_b:
        print(f"{k[0]} · {k[1]} : seulement dans B")

    print(f"\nPARITÉ : {'OK' if gaps == 0 else f'{gaps} écart(s) — comparaison à interpréter avec prudence'}")
    return 0 if gaps == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
