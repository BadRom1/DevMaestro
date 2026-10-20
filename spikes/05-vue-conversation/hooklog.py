#!/usr/bin/env python3
"""Hook de journalisation : ajoute {ts, event, payload} à $SPIKE05_OUT/hooks.jsonl, sort en 0 sans rien imprimer.

Usage (dans le fichier passé par --settings) : python3 hooklog.py <Événement>
"""
import json
import os
import sys
import time


def main():
    ts = time.time()
    event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        payload = {"_raw": raw[:500]}
    out = os.environ.get("SPIKE05_OUT")
    if not out:
        return
    line = json.dumps({"ts": ts, "event": event, "payload": payload}, ensure_ascii=False) + "\n"
    # Un seul write() en O_APPEND : des hooks parallèles ne mélangent pas leurs lignes.
    fd = os.open(os.path.join(out, "hooks.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except BaseException:  # noqa: BLE001 — ne jamais casser claude
        pass
    sys.exit(0)
