#!/usr/bin/env python3
"""Envoie des commandes à harness.py.

Usage : send.py <sortie> text "…" | paste "…" | keys enter [esc …] | prompt "…" (texte, 1 s, Entrée)
"""
import json
import os
import sys
import time

out, kind, *rest = sys.argv[1:]
fifo = os.path.join(out, "in.fifo")


def send(cmd):
    with open(fifo, "w") as f:
        f.write(json.dumps(cmd) + "\n")


if kind == "keys":
    for k in rest:
        send({"keys": k})
        time.sleep(0.3)
elif kind == "prompt":
    send({"text": rest[0]})
    time.sleep(1)
    send({"keys": "enter"})
else:
    send({kind: rest[0]})
