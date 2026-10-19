#!/usr/bin/env python3
"""Envoie une commande à ptyhost.py par out/inject.fifo.

  inject.py paste "<texte>"        (\\n dans le texte = retour à la ligne)
  inject.py paste-file <chemin>
  inject.py keys shift-tab [n]
  inject.py keys enter|esc|ctrl-c [n]
"""
import fcntl
import json
import os
import sys

FIFO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "inject.fifo")


def commands(args):
    if len(args) == 2 and args[0] == "paste":
        return [{"paste": args[1].replace("\\n", "\n")}]
    if len(args) == 2 and args[0] == "paste-file":
        with open(args[1], encoding="utf-8") as f:
            return [{"paste": f.read()}]
    if args[:1] == ["keys"] and len(args) in (2, 3) and args[1] in ("shift-tab", "enter", "esc", "ctrl-c"):
        return [{"keys": args[1]}] * (int(args[2]) if len(args) == 3 else 1)
    sys.exit(__doc__)


def main():
    cmds = commands(sys.argv[1:])
    if not os.path.exists(FIFO):
        sys.exit("Pas de FIFO : ptyhost.py ne tourne pas (lancer run.sh sans --no-ptyhost).")
    # O_NONBLOCK : échoue tout de suite (ENXIO) si personne ne lit, au lieu de bloquer.
    fd = os.open(FIFO, os.O_WRONLY | os.O_NONBLOCK)
    fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) & ~os.O_NONBLOCK)
    try:
        os.write(fd, "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in cmds).encode("utf-8"))
    finally:
        os.close(fd)
    print(f"{len(cmds)} commande(s) envoyée(s).")


if __name__ == "__main__":
    main()
