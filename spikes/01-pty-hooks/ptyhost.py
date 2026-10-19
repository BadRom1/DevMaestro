#!/usr/bin/env python3
"""Lance une commande dans un PTY relié au terminal courant, et accepte des injections sur out/inject.fifo.

Usage : ptyhost.py -- <commande...>
Commandes FIFO (une ligne JSON) : {"paste": "texte"} | {"keys": "shift-tab"|"enter"|"esc"}
"""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
FIFO = os.path.join(OUT, "inject.fifo")
KEYS = {"shift-tab": b"\x1b[Z", "enter": b"\r", "esc": b"\x1b"}


def log(**fields):
    line = json.dumps({"ts": time.time(), "event": "ptyhost.inject", **fields}, ensure_ascii=False) + "\n"
    fd = os.open(os.path.join(OUT, "events.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))  # un seul write en O_APPEND, comme relay.py
    finally:
        os.close(fd)


def get_winsize():
    return fcntl.ioctl(1, termios.TIOCGWINSZ, b"\0" * 8) if os.isatty(1) else None


def copy_winsize(fd):
    size = get_winsize()
    if size:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)


def describe(cmd):
    """Ce qu'on journalise : la longueur du texte collé, pas le texte."""
    return {"paste_len": len(cmd["paste"])} if "paste" in cmd else cmd


class Stop(Exception):
    """SIGTERM ou SIGHUP reçu : on sort proprement (restauration du terminal)."""


def encode(cmd):
    if not isinstance(cmd, dict):
        raise ValueError(f"objet JSON attendu : {cmd!r}")
    if isinstance(cmd.get("paste"), str):
        return b"\x1b[200~" + cmd["paste"].encode("utf-8") + b"\x1b[201~"
    if cmd.get("keys") in KEYS:
        return KEYS[cmd["keys"]]
    raise ValueError(f"commande inconnue : {cmd}")


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def main():
    argv = sys.argv[1:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        sys.exit(__doc__)
    os.makedirs(OUT, exist_ok=True)
    if os.path.exists(FIFO):
        os.remove(FIFO)
    os.mkfifo(FIFO)
    # O_RDWR : la FIFO reste ouverte même quand aucun inject.py n'écrit (sinon EOF en boucle).
    fifo_fd = os.open(FIFO, os.O_RDWR | os.O_NONBLOCK)

    size = get_winsize()  # lue avant fork : dans l'enfant, fd 1 est déjà l'esclave
    pid, master_fd = pty.fork()
    if pid == 0:
        try:
            # Taille posée sur l'esclave avant exec : claude ne démarre pas en 0x0.
            if size:
                fcntl.ioctl(0, termios.TIOCSWINSZ, size)
            os.execvp(argv[0], argv)
        finally:
            os._exit(127)

    copy_winsize(master_fd)
    signal.signal(signal.SIGWINCH, lambda *_: copy_winsize(master_fd))

    def on_stop(signum, _frame):
        try:
            os.kill(pid, signal.SIGHUP if signum == signal.SIGHUP else signal.SIGTERM)
        except OSError:
            pass
        raise Stop(signal.Signals(signum).name)

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGHUP, on_stop)
    saved = termios.tcgetattr(0) if os.isatty(0) else None
    if saved:
        tty.setraw(0)
    stdin_open = True
    fifo_buf = b""
    try:
        while True:
            fds = [master_fd, fifo_fd] + ([0] if stdin_open else [])
            try:
                ready, _, _ = select.select(fds, [], [])
            except InterruptedError:
                continue  # SIGWINCH
            if master_fd in ready:
                try:
                    data = os.read(master_fd, 65536)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    data = b""  # EIO : l'enfant a fermé le PTY
                if not data:
                    break
                write_all(1, data)
            if 0 in ready:
                data = os.read(0, 65536)
                if data:
                    write_all(master_fd, data)
                else:
                    stdin_open = False  # stdin fermé (tests non interactifs) : on continue
            if fifo_fd in ready:
                fifo_buf += os.read(fifo_fd, 65536)
                while b"\n" in fifo_buf:
                    line, fifo_buf = fifo_buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        cmd = json.loads(line)
                        payload = encode(cmd)
                        write_all(master_fd, payload)
                        log(cmd=describe(cmd), bytes=len(payload))
                    except Exception as exc:  # noqa: BLE001 — une ligne invalide ne tue pas la session
                        log(error=repr(exc), line=line.decode("utf-8", "replace")[:200])
    except Stop:
        pass
    finally:
        if saved:
            termios.tcsetattr(0, termios.TCSAFLUSH, saved)
        os.close(fifo_fd)
        try:
            os.remove(FIFO)
        except OSError:
            pass
    return reap(pid)


def reap(pid):
    """Attend l'enfant ; s'il ignore SIGTERM/SIGHUP plus de 3 s, SIGKILL."""
    for _ in range(30):
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.1)
    os.kill(pid, signal.SIGKILL)
    return os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])


if __name__ == "__main__":
    code = main()
    sys.exit(code if code >= 0 else 128 - code)
