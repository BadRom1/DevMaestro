#!/usr/bin/env python3
"""Affiche out/events.jsonl, un événement par ligne.

  show.py [--session <début d'id>] [-f]   tout le fichier (ou une session), -f : suit les ajouts
  show.py --raw N                         JSON complet de la ligne N (numérotée comme dans l'affichage)
"""
import datetime
import json
import os
import sys
import time

EVENTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "events.jsonl")


def summary(e):
    p = e.get("payload") or {}
    parts = []
    if "orch_token_present" in e:
        parts.append("token=" + ("ok" if e["orch_token_matches"] else "présent≠" if e["orch_token_present"] else "absent"))
    for key in ("session_id", "permission_mode", "tool_name", "notification_type", "reason", "error", "source"):
        if p.get(key):
            parts.append(f"{key}={str(p[key])[:8] if key == 'session_id' else p[key]}")
    if p.get("tool_input"):
        parts.append("input=" + json.dumps(p["tool_input"], ensure_ascii=False)[:80])
    if p.get("prompt"):
        parts.append("prompt=" + json.dumps(p["prompt"], ensure_ascii=False)[:80])
    for key in ("id", "outcome", "waited_s", "cmd", "error"):
        if key in e:
            parts.append(f"{key}={json.dumps(e[key], ensure_ascii=False)[:80]}")
    return "  ".join(parts)


class Printer:
    def __init__(self, session):
        self.session = session  # filtre (début d'id) ou None
        self.run_session = None  # session du dernier run.start : rattache les lignes sans session_id

    def line(self, n, raw):
        try:
            e = json.loads(raw)
        except ValueError:
            if not self.session:
                print(f"{n:4} ?? {raw.strip()[:120]}")
            return
        if e.get("event") == "run.start":
            self.run_session = e.get("session_id")
        sid = (e.get("payload") or {}).get("session_id") or self.run_session or ""
        if self.session and not sid.startswith(self.session):
            return
        t = datetime.datetime.fromtimestamp(e.get("ts", 0)).strftime("%H:%M:%S.%f")[:-3]
        if e.get("event") == "run.start":
            print(f"{'═' * 100}\n{n:4} {t}  RUN {e['session_id']}  profil={e['profile']}  variante={e['variant']}  "
                  f"mode={e['mode']}  délai={e['timeout']} s  ptyhost={e['ptyhost']}  {e['claude_version']}", flush=True)
        else:
            print(f"{n:4} {t}  {e.get('event', '?'):18} {summary(e)}", flush=True)


def main():
    args = sys.argv[1:]
    if not os.path.exists(EVENTS):
        sys.exit("Pas encore d'out/events.jsonl.")
    with open(EVENTS, encoding="utf-8") as f:
        if args[:1] == ["--raw"]:
            line = f.readlines()[int(args[1]) - 1]
            print(json.dumps(json.loads(line), indent=2, ensure_ascii=False))
            return
        session = args[args.index("--session") + 1] if "--session" in args else None
        printer = Printer(session)
        n = 0
        for n, line in enumerate(f, 1):
            printer.line(n, line)
        while "-f" in args:
            line = f.readline()
            if line:
                n += 1
                printer.line(n, line)
            else:
                time.sleep(0.3)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
