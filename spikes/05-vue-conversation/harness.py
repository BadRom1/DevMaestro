#!/usr/bin/env python3
"""Hôte PTY du prototype n° 5 : lance le vrai `claude` interactif sans terminal, horodate chaque lecture
du PTY, journalise les hooks et lance le suiveur de transcript.

Usage : harness.py <dossier de sortie> <dossier de travail> -- <arguments de claude...>

Dans <sortie> :
  pty-raw.bin      flux brut du PTY ;
  pty-index.jsonl  {ts, off, n} par read() (off = position dans pty-raw.bin) ;
  hooks.jsonl      événements de hooks horodatés (hooklog.py) ;
  inject.jsonl     ce que l'on a envoyé, horodaté ;
  follow.jsonl     suiveur de transcript (follow.py) ;
  in.fifo          commandes (une ligne JSON) : {"text": "..."} | {"paste": "..."} | {"keys": "enter"|"esc"|...}
"""
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time
import fcntl
import struct
import termios

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
KEYS = {"enter": b"\r", "esc": b"\x1b", "shift-tab": b"\x1b[Z", "ctrl-c": b"\x03", "up": b"\x1b[A",
        "down": b"\x1b[B", "left": b"\x1b[D", "right": b"\x1b[C", "tab": b"\t", "space": b" "}
HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
               "PermissionRequest", "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart",
               "SubagentStop", "PreCompact", "SessionEnd"]


def clean_env():
    """Retire les marqueurs de session Claude Code, lus dans crates/core/src/daemon/launch.rs."""
    src = open(os.path.join(REPO, "crates/core/src/daemon/launch.rs"), encoding="utf-8").read()

    def consts(name):
        m = re.search(name + r": &\[&str\] = &\[(.*?)\];", src, re.S)
        return re.findall(r'"([A-Z0-9_]+)"', m.group(1)) if m else []

    names, prefixes = set(consts("CLAUDE_SESSION_MARKERS")), tuple(consts("CLAUDE_SESSION_MARKER_PREFIXES"))
    env = {k: v for k, v in os.environ.items() if k not in names and not k.startswith(prefixes)}
    env.pop("CLAUDE_CONFIG_DIR", None)  # profil perso
    return env, sorted(set(os.environ) - set(env))


def project_dir(cwd):
    """Dossier des transcripts du cwd (profil perso) : chaque caractère non alphanumérique devient « - »."""
    return os.path.join(os.path.expanduser("~/.claude/projects"), re.sub(r"[^A-Za-z0-9]", "-", cwd))


def write_settings(out):
    hooks = {}
    for ev in HOOK_EVENTS:
        entry = {"hooks": [{"type": "command", "command": f"python3 {HERE}/hooklog.py {ev}"}]}
        if ev in ("PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"):
            entry["matcher"] = "*"
        hooks[ev] = [entry]
    path = os.path.join(out, "settings.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"hooks": hooks}, f, indent=1)
    return path


def log(out, **d):
    with open(os.path.join(out, "inject.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.time(), **d}, ensure_ascii=False) + "\n")


def encode(cmd):
    if "text" in cmd:
        return cmd["text"].encode()
    if "paste" in cmd:
        return b"\x1b[200~" + cmd["paste"].encode() + b"\x1b[201~"
    if "keys" in cmd:
        return KEYS[cmd["keys"]]
    raise ValueError(cmd)


def main():
    out, cwd = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    claude_args = sys.argv[sys.argv.index("--") + 1:]
    os.makedirs(out, exist_ok=True)
    env, removed = clean_env()
    env["SPIKE05_OUT"] = out
    # Variables ajoutées volontairement (ex. CLAUDE_CODE_EAGER_FLUSH=1) : SPIKE05_EXTRA_ENV="K=V K2=V2".
    for kv in os.environ.get("SPIKE05_EXTRA_ENV", "").split():
        k, _, v = kv.partition("=")
        env[k] = v
    env.pop("SPIKE05_EXTRA_ENV", None)
    settings = write_settings(out)
    argv = ["claude", "--settings", settings] + claude_args
    log(out, event="start", argv=argv, removed_env=removed, cwd=cwd,
        extra_env=os.environ.get("SPIKE05_EXTRA_ENV", ""))

    fifo = os.path.join(out, "in.fifo")
    if os.path.exists(fifo):
        os.remove(fifo)
    os.mkfifo(fifo)
    fifo_fd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
    stop_file = os.path.join(out, "follow.stop")
    if os.path.exists(stop_file):
        os.remove(stop_file)
    follower = subprocess.Popen([sys.executable, os.path.join(HERE, "follow.py"), os.path.join(out, "hooks.jsonl"),
                                 os.path.join(out, "follow.jsonl"), "--stop-file", stop_file,
                                 "--dir", project_dir(cwd)])

    pid, master = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
        env["TERM"] = "xterm-256color"
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    raw = open(os.path.join(out, "pty-raw.bin"), "ab")
    idx = open(os.path.join(out, "pty-index.jsonl"), "a")
    off = raw.tell()
    buf = b""
    try:
        while True:
            r, _, _ = select.select([master, fifo_fd], [], [], 1.0)
            if master in r:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                ts = time.time()
                raw.write(data)
                raw.flush()
                idx.write(json.dumps({"ts": ts, "off": off, "n": len(data)}) + "\n")
                idx.flush()
                off += len(data)
                # Réponses minimales aux requêtes du terminal (position du curseur, attributs).
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[c" in data or b"\x1b[0c" in data:
                    os.write(master, b"\x1b[?62;22c")
            if fifo_fd in r:
                buf += os.read(fifo_fd, 65536)
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        cmd = json.loads(line)
                        payload = encode(cmd)
                        os.write(master, payload)
                        log(out, event="send", cmd={k: (v if k == "keys" else len(v)) for k, v in cmd.items()},
                            bytes=len(payload))
                    except Exception as exc:  # noqa: BLE001
                        log(out, event="error", error=repr(exc))
    finally:
        try:
            _, status = os.waitpid(pid, 0)
            log(out, event="exit", status=status)
        except ChildProcessError:
            pass
        time.sleep(1.0)
        open(stop_file, "w").close()
        follower.wait(timeout=10)
        os.remove(fifo)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    main()
