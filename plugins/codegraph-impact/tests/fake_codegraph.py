#!/usr/bin/env python3
"""Faux ``codegraph`` des tests : rejoue des sorties réelles du prototype n° 6.

Réglé par le fichier JSON désigné par ``FAKE_CG_CONFIG`` :

- ``log`` : fichier où chaque appel ajoute une ligne JSON (argv, cwd, environnement, stdin) ;
- ``node`` : ``{chemin: fichier de sortie}`` pour ``node -f <chemin> --symbols-only`` ;
- ``impact`` : ``{"chemin::symbole" ou "symbole": fichier JSON}`` pour ``impact`` ;
- ``affected`` : fichier JSON rendu par ``affected`` ;
- ``index_sleep``, ``index_rc`` : durée et code de sortie de ``init``/``sync``/``index`` ;
- ``impact_sleep`` : attente de chaque ``impact`` (tests du budget).
"""

import json
import os
import sys
import time

ENV_KEYS = [
    "DO_NOT_TRACK",
    "CODEGRAPH_TELEMETRY",
    "CODEGRAPH_NO_UPDATE_CHECK",
    "CODEGRAPH_NO_DAEMON",
    "CODEGRAPH_NO_DOWNLOAD",
    "NO_COLOR",
]


def opt(argv, *names):
    for i, a in enumerate(argv):
        if a in names and i + 1 < len(argv):
            return argv[i + 1]
    return None


def main():
    with open(os.environ["FAKE_CG_CONFIG"], encoding="utf-8") as f:
        cfg = json.load(f)
    argv = sys.argv[1:]
    sub = argv[0] if argv else ""
    stdin = sys.stdin.read() if sub == "affected" else ""
    entry = {
        "argv": argv,
        "cwd": os.getcwd(),
        "env": {k: os.environ.get(k) for k in ENV_KEYS},
        "ppid_comm": "",
        "stdin": stdin,
    }
    try:
        with open(f"/proc/{os.getppid()}/comm", encoding="utf-8") as f:
            entry["ppid_comm"] = f.read().strip()
    except OSError:
        pass
    with open(cfg["log"], "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")

    if "install" in argv:
        sys.stderr.write("interdit : install\n")
        return 99

    if sub in ("init", "sync", "index"):
        path = argv[-1]
        steps = ["┌  Initializing CodeGraph", "Scanning files...", "Parsing code...", "Resolving refs..."]
        sleep = float(cfg.get("index_sleep", 0))
        for i, step in enumerate(steps):
            sys.stdout.write(("\r" if i else "") + "\x1b[32m" + step + "\x1b[0m\n")
            sys.stdout.flush()
            time.sleep(sleep / len(steps))
        rc = int(cfg.get("index_rc", 0))
        if rc:
            sys.stdout.write("│\n■  Indexing failed: disk full\n")
            return rc
        os.makedirs(os.path.join(path, ".codegraph"), exist_ok=True)
        with open(os.path.join(path, ".codegraph", "codegraph.db"), "w", encoding="utf-8") as f:
            f.write("faux index\n")
        sys.stdout.write("◆  Indexed 2 files\n└  Done\n")
        return 0

    if sub == "node":
        path = opt(argv, "-f", "--file")
        src = cfg.get("node", {}).get(path)
        if not src:
            sys.stdout.write(f"ℹ File \"{path}\" not found\n")
            return 0
        with open(src, encoding="utf-8") as f:
            sys.stdout.write(f.read())
        return 0

    if sub == "impact":
        # Le plugin passe le symbole après `--` (jamais lu comme une option).
        symbol = argv[argv.index("--") + 1] if "--" in argv else argv[1]
        path = opt(argv, "-f", "--file")
        time.sleep(float(cfg.get("impact_sleep", 0)))
        table = cfg.get("impact", {})
        src = table.get(f"{path}::{symbol}") or table.get(symbol)
        if not src:
            sys.stdout.write(f"ℹ Symbol \"{symbol}\" not found\n")
            return 0
        with open(src, encoding="utf-8") as f:
            sys.stdout.write(f.read())
        return 0

    if sub == "affected":
        src = cfg.get("affected")
        if not src:
            sys.stdout.write(json.dumps({"changedFiles": [], "affectedTests": [], "totalDependentsTraversed": 0}))
            return 0
        if src == "fail":
            sys.stderr.write("affected: base absente\n")
            return 1
        with open(src, encoding="utf-8") as f:
            sys.stdout.write(f.read())
        return 0

    sys.stderr.write(f"sous-commande inattendue : {sub}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
