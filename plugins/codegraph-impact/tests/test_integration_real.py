"""Essai réel, facultatif : la vraie CLI CodeGraph désignée par ``DEVMAESTRO_TEST_CODEGRAPH``.

Exemple : ``DEVMAESTRO_TEST_CODEGRAPH=/chemin/vers/cgenv.sh`` (enveloppe qui isole HOME/XDG
et coupe la télémétrie). Sauté proprement si la variable est absente.
"""

import os
import shutil
import tempfile
import time
import unittest

from helpers import PluginProcess, git

CODEGRAPH = os.environ.get("DEVMAESTRO_TEST_CODEGRAPH")


@unittest.skipUnless(CODEGRAPH and os.path.isabs(CODEGRAPH) and os.access(CODEGRAPH, os.X_OK),
                     "DEVMAESTRO_TEST_CODEGRAPH ne désigne pas un exécutable (chemin absolu)")
class RealCodegraphTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cg-impact-real-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(self.root, "src"))
        os.makedirs(os.path.join(self.root, "test"))
        files = {
            "src/math.ts": "export function double(n: number): number {\n  return n * 2;\n}\n\n"
                           "export function triple(n: number): number {\n  return n * 3;\n}\n",
            "src/use.ts": "import { double } from './math';\n\nexport function quadruple(n: number): number {\n"
                          "  return double(double(n));\n}\n",
            "test/use.test.ts": "import { quadruple } from '../src/use';\n\nexport function check(): boolean {\n"
                                "  return quadruple(1) === 4;\n}\n",
        }
        for path, content in files.items():
            with open(os.path.join(self.root, path), "w") as f:
                f.write(content)
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "add", ".")
        git(self.root, "commit", "-q", "-m", "base")
        self.sha = git(self.root, "rev-parse", "HEAD").strip()
        with open(os.path.join(self.root, "src/math.ts"), "w") as f:
            f.write(files["src/math.ts"].replace("n * 2", "n + n"))
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=self.tmp)
        self.plugin = PluginProcess(env=env)
        self.addCleanup(self.plugin.dispose)
        self.plugin.request("initialize", {"api_version": 1, "locale": "fr",
                                           "config": {"codegraph": CODEGRAPH, "depth": 2}})

    def params(self):
        return {"locale": "fr", "session": {"id": "s", "cwd": self.root, "worktree_root": self.root, "branch": "main"},
                "diff": {"base": {"ref": "main", "sha": self.sha, "kind": "branch"},
                         "files": [{"path": "src/math.ts", "status": "M", "additions": 1, "deletions": 1,
                                    "binary": False}],
                         "truncated": False}}

    def test_index_then_render(self):
        res = self.plugin.request("action.run", dict(self.params(), action="index", args={}))["result"]
        self.assertIn("refresh_ms", res["document"])
        deadline = time.monotonic() + 180
        doc = None
        while time.monotonic() < deadline:
            doc = self.plugin.request("panel.render", self.params())["result"]
            if "refresh_ms" not in doc:
                break
            time.sleep(0.5)
        self.assertNotIn("refresh_ms", doc, doc)
        errors = [b for b in doc["blocks"] if b["type"] == "notice" and b["level"] == "error"]
        self.assertEqual(errors, [])
        table = [b for b in doc["blocks"] if b["type"] == "table"][0]
        rows = {r["symbol"]: r for r in table["rows"]}
        self.assertEqual(rows["double"]["depth"], 0)
        self.assertNotIn("triple", rows)  # hors des lignes modifiées
        self.assertEqual(rows["quadruple"]["depth"], 1)
        with open(os.path.join(self.root, ".git", "info", "exclude")) as f:
            self.assertIn("/.codegraph/", f.read().splitlines())
        self.assertEqual(git(self.root, "status", "--porcelain"), " M src/math.ts\n")
        sent = self.plugin.request("action.run", dict(self.params(), action="send-impact", args={}))["result"]
        self.assertIn("`double`", sent["propose"]["content"])


if __name__ == "__main__":
    unittest.main()
