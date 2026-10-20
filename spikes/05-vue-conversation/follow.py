#!/usr/bin/env python3
"""Suiveur de transcript : horodate chaque nouvelle ligne du .jsonl d'une session et de ses sous-agents.

Usage : follow.py <hooks.jsonl> <sortie follow.jsonl> [--stop-file <chemin>] [--dir <dossier du projet>]

Le dossier à suivre se découvre comme le ferait le démon : par le champ `transcript_path` des hooks
(il change après /clear). On suit tout le dossier du projet (nouveaux .jsonl, dossier
`<session>/subagents/`). inotify (via ctypes) réveille la boucle ; un tour de scrutation toutes les
50 ms rattrape ce qu'inotify n'aurait pas signalé.

Deux sortes de lignes dans la sortie :
- {"k": "grow", ...}  : le fichier a grossi (octets lus, la lecture finit-elle par \n ?) ;
- {"k": "line", ...}  : une ligne JSON complète est arrivée (type, sous-type, uuid, message.id,
  types de blocs, `timestamp` interne de l'entrée, clés de premier niveau). Aucun contenu.
"""
import ctypes
import ctypes.util
import datetime
import json
import os
import select
import struct
import sys
import time

IN_MODIFY, IN_CREATE, IN_MOVED_TO, IN_CLOSE_WRITE = 0x2, 0x100, 0x80, 0x8


class Inotify:
    def __init__(self):
        self.fd = None
        try:
            libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
            fd = libc.inotify_init1(os.O_NONBLOCK)
            if fd >= 0:
                self.fd, self.libc = fd, libc
        except (OSError, AttributeError):
            pass
        self.watched = set()

    def watch(self, path):
        if self.fd is None or path in self.watched or not os.path.isdir(path):
            return
        if self.libc.inotify_add_watch(self.fd, path.encode(), IN_MODIFY | IN_CREATE | IN_MOVED_TO | IN_CLOSE_WRITE) >= 0:
            self.watched.add(path)

    def drain(self):
        try:
            while os.read(self.fd, 65536):
                pass
        except BlockingIOError:
            pass


def parse_ts(s):
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        return None


def describe(e):
    d = {"type": e.get("type"), "keys": sorted(e.keys())}
    for k in ("subtype", "uuid", "parentUuid", "isSidechain", "isMeta", "agentId", "sessionId", "version"):
        if k in e:
            d[k] = e[k]
    if isinstance(e.get("attachment"), dict):
        d["attachment"] = e["attachment"].get("type")
    msg = e.get("message")
    if isinstance(msg, dict):
        d["msg_id"] = msg.get("id")
        d["stop_reason"] = msg.get("stop_reason")
        c = msg.get("content")
        if isinstance(c, list):
            d["blocks"] = [b.get("type") for b in c if isinstance(b, dict)]
            d["tool_use_ids"] = [b.get("id") or b.get("tool_use_id") for b in c
                                 if isinstance(b, dict) and b.get("type") in ("tool_use", "tool_result")]
            d["text_len"] = sum(len(b.get("text") or "") for b in c if isinstance(b, dict))
        elif isinstance(c, str):
            d["blocks"] = ["<str>"]
            d["text_len"] = len(c)
            d["head"] = c[:40]  # nos sessions de test seulement : début du prompt pour s'y retrouver
    if "timestamp" in e:
        d["entry_ts"] = parse_ts(e["timestamp"])
    return d


class Follower:
    def __init__(self, hooks_path, out_path, stop_file=None, initial_dirs=()):
        self.hooks_path, self.stop_file = hooks_path, stop_file
        self.out = open(out_path, "a", encoding="utf-8")
        self.ino = Inotify()
        self.hooks_off = 0
        self.dirs = set()
        self.files = {}  # chemin -> [offset, reste partiel, n° de ligne]
        self.t_start = time.time()
        # Dossiers connus d'avance (le démon connaît le cwd) : on note la taille de leurs fichiers au départ,
        # seules les lignes ajoutées ensuite comptent. Un fichier découvert plus tard est lu depuis 0.
        self.initial_sizes = {}
        for d in initial_dirs:
            self.dirs.add(d)
            for dp, _dirs, names in os.walk(d):
                for n in names:
                    if n.endswith(".jsonl"):
                        p = os.path.join(dp, n)
                        self.initial_sizes[p] = os.path.getsize(p)

    def emit(self, **d):
        self.out.write(json.dumps(d, ensure_ascii=False) + "\n")
        self.out.flush()

    def scan_hooks(self):
        try:
            with open(self.hooks_path, "rb") as f:
                f.seek(self.hooks_off)
                data = f.read()
        except OSError:
            return
        end = data.rfind(b"\n")
        if end < 0:
            return
        self.hooks_off += end + 1
        for raw in data[: end + 1].splitlines():
            try:
                p = json.loads(raw).get("payload", {})
            except ValueError:
                continue
            for key in ("transcript_path", "agent_transcript_path"):
                tp = p.get(key)
                if tp:
                    d = os.path.dirname(tp)
                    # dossier du projet : celui du transcript principal (pas `subagents/`)
                    if os.path.basename(d) == "subagents":
                        d = os.path.dirname(os.path.dirname(d))
                    if d not in self.dirs:
                        self.dirs.add(d)
                        self.emit(k="dir", ts=time.time(), dir=d)

    def scan_dir(self, d):
        self.ino.watch(d)
        try:
            names = os.listdir(d)
        except OSError:
            return
        for n in names:
            p = os.path.join(d, n)
            if n.endswith(".jsonl"):
                if p not in self.files:
                    # Fichier antérieur au suiveur : on part de sa taille au départ.
                    old = p in self.initial_sizes
                    self.files[p] = [self.initial_sizes.get(p, 0), b"", 0]
                    self.emit(k="file", ts=time.time(), file=p, preexisting=old, start_offset=self.files[p][0])
            elif os.path.isdir(p) and (n == "subagents" or len(n) == 36):
                self.scan_dir(p)

    def read_file(self, p):
        st = self.files[p]
        try:
            with open(p, "rb") as f:
                f.seek(st[0])
                data = f.read()
        except OSError:
            return
        if not data:
            return
        now = time.time()
        st[0] += len(data)
        self.emit(k="grow", ts=now, file=p, bytes=len(data), ends_nl=data.endswith(b"\n"), offset=st[0])
        buf = st[1] + data
        *lines, st[1] = buf.split(b"\n")
        for raw in lines:
            if not raw.strip():
                continue
            st[2] += 1
            try:
                e = json.loads(raw)
                d = describe(e) if isinstance(e, dict) else {"type": "<non-objet>"}
            except ValueError:
                d = {"type": "<json invalide>"}
            self.emit(k="line", ts=now, file=p, n=st[2], len=len(raw), **d)

    def tick(self):
        self.scan_hooks()
        for d in list(self.dirs):
            self.scan_dir(d)
        for p in list(self.files):
            self.read_file(p)

    def run(self):
        self.emit(k="start", ts=time.time(), inotify=self.ino.fd is not None)
        while True:
            if self.stop_file and os.path.exists(self.stop_file):
                self.tick()
                break
            if self.ino.fd is not None:
                r, _, _ = select.select([self.ino.fd], [], [], 0.05)
                if r:
                    self.ino.drain()
            else:
                time.sleep(0.05)
            self.tick()
        self.emit(k="stop", ts=time.time(), cpu_s=round(time.process_time(), 3))


if __name__ == "__main__":
    args = sys.argv[1:]
    stop, dirs = None, []
    if "--stop-file" in args:
        i = args.index("--stop-file")
        stop = args[i + 1]
        del args[i: i + 2]
    while "--dir" in args:
        i = args.index("--dir")
        dirs.append(args[i + 1])
        del args[i: i + 2]
    Follower(args[0], args[1], stop, dirs).run()
