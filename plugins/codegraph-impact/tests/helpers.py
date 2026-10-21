"""Outillage commun des tests du plugin ``codegraph-impact`` (bibliothèque standard)."""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.dirname(TESTS_DIR)
PLUGIN_FILE = os.path.join(PLUGIN_DIR, "codegraph_impact.py")
FIXTURES = os.path.join(TESTS_DIR, "fixtures")
FAKE_CODEGRAPH = os.path.join(TESTS_DIR, "fake_codegraph.py")


def load_plugin_module():
    spec = importlib.util.spec_from_file_location("codegraph_impact_under_test", PLUGIN_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fixture(name):
    return os.path.join(FIXTURES, name)


def git(cwd, *args):
    env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
    return subprocess.run(["git", "-C", cwd] + list(args), check=True, capture_output=True, text=True, env=env).stdout


def snapshot(root):
    """Contenu de tous les fichiers sous ``root`` (``.git`` compris) : ``{chemin: octets}``."""
    files = {}
    for base, dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(base, name)
            if os.path.islink(path):
                files[os.path.relpath(path, root)] = ("lien", os.readlink(path))
                continue
            with open(path, "rb") as f:
                files[os.path.relpath(path, root)] = f.read()
    return files


def symbols_md(path, symbols):
    """Sortie Markdown de ``node --symbols-only`` (format relevé sur CodeGraph 1.6.2)."""
    lines = [f"**{path}** — {len(symbols)} symbols, used by 0 files", "", "**Symbols**"]
    for name, kind, line in symbols:
        lines.append(f"- `{name}` ({kind}) (): void — :{line}")
    lines += ["", "> Drop `symbolsOnly` (or pass `offset`/`limit`) to read the source, like Read."]
    return "\n".join(lines) + "\n"


class FakeCodegraphCase(unittest.TestCase):
    """Dossier temporaire, faux ``codegraph`` réglé par un fichier JSON, journal des appels."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cg-impact-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "wt")
        os.makedirs(self.root)
        self.log_path = os.path.join(self.tmp, "calls.ndjson")
        self.cfg_path = os.path.join(self.tmp, "fake.json")
        self.cfg = {"log": self.log_path, "node": {}, "impact": {}}
        self.write_cfg()
        self.addCleanup(self.assert_only_read_subcommands)
        # git ne remonte jamais au-dessus du dossier temporaire (pas d'écriture dans un dépôt englobant).
        for key, value in (("FAKE_CG_CONFIG", self.cfg_path), ("GIT_CEILING_DIRECTORIES", self.tmp)):
            self.addCleanup(self._restore_env, key, os.environ.get(key))
            os.environ[key] = value

    @staticmethod
    def _restore_env(key, previous):
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous

    ALLOWED_SUBCOMMANDS = {"init", "sync", "index", "node", "impact", "affected"}

    def assert_only_read_subcommands(self):
        """Jamais `install`, `upgrade`, `telemetry`… : seules les sous-commandes d'index et de lecture."""
        for call in self.calls():
            self.assertIn(call["argv"][0], self.ALLOWED_SUBCOMMANDS, call["argv"])
            self.assertNotIn("install", call["argv"])

    def write_cfg(self):
        with open(self.cfg_path, "w", encoding="utf-8") as f:
            json.dump(self.cfg, f)

    def add_node(self, path, symbols):
        out = os.path.join(self.tmp, "node-" + path.replace("/", "_") + ".md")
        with open(out, "w", encoding="utf-8") as f:
            f.write(symbols_md(path, symbols))
        self.cfg["node"][path] = out
        self.write_cfg()

    def add_impact(self, key, src):
        self.cfg["impact"][key] = src
        self.write_cfg()

    def write_json(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return path

    def calls(self):
        if not os.path.exists(self.log_path):
            return []
        with open(self.log_path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def make_index(self, root=None):
        os.makedirs(os.path.join(root or self.root, ".codegraph"), exist_ok=True)

    def session(self, root=None, branch="feature"):
        root = root or self.root
        return {"id": "s1", "cwd": root, "worktree_root": root, "branch": branch}

    @staticmethod
    def diff(files, sha=None, truncated=False):
        return {
            "base": {"ref": "main", "sha": sha, "kind": "branch"},
            "files": [
                {"path": p, "status": s, "additions": 1, "deletions": 0, "binary": False} for p, s in files
            ],
            "truncated": truncated,
        }


class PluginProcess:
    """Le plugin lancé comme par le démon : ``python3 -I codegraph_impact.py``, tubes NDJSON."""

    def __init__(self, env=None):
        self.proc = subprocess.Popen(
            [sys.executable, "-I", PLUGIN_FILE],
            cwd=PLUGIN_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env if env is not None else dict(os.environ),
        )
        self.next_id = 0
        self.lines = []

    def send_raw(self, line):
        self.proc.stdin.write(line if isinstance(line, bytes) else line.encode("utf-8"))
        self.proc.stdin.flush()

    def read(self):
        line = self.proc.stdout.readline()
        if not line:
            raise EOFError("le plugin a fermé stdout")
        self.lines.append(line)
        return json.loads(line.decode("utf-8"))

    def request(self, method, params=None):
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send_raw(json.dumps(msg) + "\n")
        resp = self.read()
        assert resp.get("id") == self.next_id, resp
        return resp

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            rest = self.proc.stdout.read()
        except OSError:
            rest = b""
        self.lines += [l + b"\n" for l in rest.split(b"\n") if l]
        code = self.proc.wait(timeout=10)
        self.proc.stderr.close()
        self.proc.stdout.close()
        return code

    def dispose(self):
        """Ferme les tubes (et arrête le processus s'il tourne encore)."""
        if self.proc.poll() is None:
            return self.close()
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
        return self.proc.returncode
