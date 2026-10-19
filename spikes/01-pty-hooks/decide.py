#!/usr/bin/env python3
"""Répond aux PermissionRequest en attente.

  decide.py list
  decide.py <allow|deny|terminal> [id]   (sans id : la seule demande en attente)
"""
import json
import os
import sys
import time

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
PENDING = os.path.join(OUT, "pending")
DECISIONS = os.path.join(OUT, "decisions")


def pending():
    if not os.path.isdir(PENDING):
        return []
    items = []
    for name in sorted(os.listdir(PENDING)):
        if name.endswith(".json"):
            try:
                with open(os.path.join(PENDING, name), encoding="utf-8") as f:
                    items.append(json.load(f))
            except (OSError, ValueError):
                pass  # fichier en cours d'écriture ou déjà supprimé
    return items


def show(items):
    if not items:
        print("Aucune permission en attente.")
    for it in items:
        p = it.get("payload", {})
        tool_input = json.dumps(p.get("tool_input"), ensure_ascii=False)
        age = int(time.time() - it.get("since", time.time()))
        print(f"{it['id']}  {p.get('tool_name')}  ({age} s)  {tool_input[:100]}")


def answer(decision, req_id):
    items = pending()
    if req_id is None:
        if len(items) != 1:
            show(items)
            sys.exit(f"Il faut préciser l'id : {len(items)} demande(s) en attente.")
        req_id = items[0]["id"]
    elif not any(it["id"] == req_id for it in items):
        sys.exit(f"Aucune demande en attente avec l'id {req_id}.")
    os.makedirs(DECISIONS, exist_ok=True)
    path = os.path.join(DECISIONS, f"{req_id}.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"decision": decision}, f)
    os.replace(path + ".tmp", path)  # écriture atomique : relay ne lit jamais un fichier à moitié écrit
    print(f"{decision} → {req_id}")


def main():
    args = sys.argv[1:]
    if args[:1] == ["list"]:
        show(pending())
    elif args and args[0] in ("allow", "deny", "terminal") and len(args) <= 2:
        answer(args[0], args[1] if len(args) == 2 else None)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
