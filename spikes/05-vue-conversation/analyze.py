#!/usr/bin/env python3
"""Chronologie d'une session de test : hooks, lignes du transcript, apparition de marqueurs à l'écran.

Usage : analyze.py <sortie> [--markers M1,M2,...] [--since <ts>] [--until <ts>]

Pour chaque marqueur (mot unique demandé à Claude), donne l'instant où il devient visible dans la TUI
(émulateur screen.py) et l'instant où la ligne du transcript qui le contient est lue par le suiveur.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from screen import replay  # noqa: E402


def load(path):
    if not os.path.exists(path):
        return []
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def main():
    a = sys.argv[1:]
    out = a[0]
    markers = a[a.index("--markers") + 1].split(",") if "--markers" in a else []
    since = float(a[a.index("--since") + 1]) if "--since" in a else 0
    until = float(a[a.index("--until") + 1]) if "--until" in a else 1e12
    hooks = load(os.path.join(out, "hooks.jsonl"))
    follow = load(os.path.join(out, "follow.jsonl"))
    inject = load(os.path.join(out, "inject.jsonl"))

    # Marqueurs → uuid des entrées qui les contiennent (lecture des transcripts de NOS sessions).
    marker_uuid, snippet = {}, {}
    for f in {d["file"] for d in follow if d.get("k") == "file"}:
        for raw in open(f, encoding="utf-8"):
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if e.get("type") != "assistant":
                continue
            for b in e.get("message", {}).get("content", []):
                t = b.get("text") or ""
                for m in markers:
                    if m in t and m not in marker_uuid:
                        marker_uuid[m] = e.get("uuid")
                        # Extrait du texte de Claude autour du marqueur (absent du prompt) : 5 mots.
                        words = t.split()
                        i = next(k for k, w in enumerate(words) if m in w)
                        snippet[m] = " ".join(words[i:i + 5] if i < len(words) / 2 else words[max(0, i - 4):i + 1])

    # Instant d'apparition à l'écran.
    seen = {}

    def on_chunk(ts, scr):
        if ts < since or len(seen) == len(markers):
            return
        txt = " ".join(" ".join(l.split()) for l in scr.text().split("\n"))
        for m in markers:
            if m not in seen and m in snippet and snippet[m] in txt:
                seen[m] = ts

    if markers:
        replay(out, on_chunk=on_chunk)

    rows = []
    for h in hooks:
        p = h["payload"]
        extra = p.get("tool_name") or p.get("source") or p.get("reason") or p.get("agent_type") or ""
        if h["event"] == "UserPromptSubmit":
            extra = (p.get("prompt") or "")[:50].replace("\n", "⏎")
        if p.get("agent_id"):
            extra += f" [agent {p['agent_id'][:8]}]"
        rows.append((h["ts"], "HOOK", f"{h['event']} {extra}"))
    for d in follow:
        if d.get("k") == "line":
            lag = f" (lag {d['ts'] - d['entry_ts']:.3f}s)" if d.get("entry_ts") else ""
            fname = os.path.basename(d["file"])[:14]
            what = d.get("type")
            if d.get("subtype"):
                what += "/" + d["subtype"]
            if d.get("attachment"):
                what += "/" + d["attachment"]
            rows.append((d["ts"], "LINE", f"{fname}#{d['n']} {what} {d.get('blocks', '')} len={d.get('len')}{lag}"
                         + (f" uuid={d['uuid'][:8]}" if d.get("uuid") else "")))
        elif d.get("k") in ("file", "dir"):
            rows.append((d["ts"], d["k"].upper(), os.path.basename(d.get("file") or d.get("dir"))))
    for i in inject:
        if i.get("event") == "send":
            rows.append((i["ts"], "SEND", json.dumps(i["cmd"])))
    for m, ts in seen.items():
        rows.append((ts, "TUI ", f"marqueur {m} visible (uuid transcript {str(marker_uuid.get(m))[:8]})"))
    rows.sort()
    t0 = None
    for ts, k, txt in rows:
        if ts < since or ts > until:
            continue
        t0 = t0 or ts
        print(f"{ts - t0:8.3f}  {k}  {txt}")
    if markers:
        print("extraits cherchés :", snippet)
        print("\nMarqueurs : écran → ligne du transcript")
        uuid_ts = {d.get("uuid"): d["ts"] for d in follow if d.get("k") == "line"}
        for m in markers:
            s, u = seen.get(m), marker_uuid.get(m)
            l = uuid_ts.get(u)
            delta = f"{l - s:+.3f} s" if s and l else "?"
            print(f"  {m}: écran {s}, transcript {l}, transcript − écran = {delta}")


if __name__ == "__main__":
    main()
