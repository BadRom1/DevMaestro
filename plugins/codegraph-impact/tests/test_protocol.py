"""Protocole : JSON-RPC 2.0 en NDJSON sur stdio, stdout réservé aux messages."""

import json
import os
import tempfile
import unittest

from helpers import FAKE_CODEGRAPH, PLUGIN_DIR, PLUGIN_FILE, PluginProcess, FakeCodegraphCase


def init_params(**over):
    params = {"api_version": 1, "locale": "fr", "config": {"codegraph": None, "depth": 2},
              "permissions": ["diff.read", "worktree.read", "worktree.write", "claude.propose"],
              "host": {"name": "devmaestro", "version": "0.3.0"}}
    params.update(over)
    return params


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.plugin = PluginProcess()
        self.addCleanup(self.plugin.dispose)

    def assert_stdout_is_json(self):
        for line in self.plugin.lines:
            obj = json.loads(line.decode("utf-8"))
            self.assertEqual(obj.get("jsonrpc"), "2.0")
            self.assertTrue(line.endswith(b"\n"))

    def test_initialize_returns_api_version(self):
        resp = self.plugin.request("initialize", init_params())
        self.assertEqual(resp, {"jsonrpc": "2.0", "id": 1, "result": {"api_version": 1}})

    def test_wrong_api_version_is_an_error(self):
        resp = self.plugin.request("initialize", init_params(api_version=2))
        self.assertIn("error", resp)
        self.assertEqual(resp["error"]["code"], -32602)
        self.assertIn("api_version", resp["error"]["message"])
        # Le processus reste en état de répondre.
        self.assertIn("result", self.plugin.request("initialize", init_params()))

    def test_unknown_method(self):
        self.plugin.request("initialize", init_params())
        resp = self.plugin.request("panel.bogus", {"locale": "en"})
        self.assertEqual(resp["error"]["code"], -32601)
        self.assertIn("unknown method", resp["error"]["message"])

    def test_invalid_json_and_notification(self):
        self.plugin.send_raw(b"{pas du json\n")
        resp = self.plugin.read()
        self.assertEqual(resp["error"]["code"], -32700)
        self.assertIsNone(resp["id"])
        # Une notification (sans id) ne reçoit aucune réponse : la suivante est celle de la requête.
        self.plugin.send_raw(json.dumps({"jsonrpc": "2.0", "method": "log", "params": {}}) + "\n")
        self.assertEqual(self.plugin.request("initialize", init_params())["result"], {"api_version": 1})

    def test_invalid_utf8(self):
        self.plugin.send_raw(b'{"jsonrpc":"2.0","id":1,"method":"\xff"}\n')
        self.assertEqual(self.plugin.read()["error"]["code"], -32700)

    def test_shutdown_answers_null_then_exits(self):
        self.plugin.request("initialize", init_params())
        resp = self.plugin.request("shutdown")
        self.assertEqual(resp, {"jsonrpc": "2.0", "id": 2, "result": None})
        self.assertEqual(self.plugin.proc.wait(timeout=10), 0)
        self.assert_stdout_is_json()

    def test_end_of_stdin_exits(self):
        self.plugin.request("initialize", init_params())
        self.assertEqual(self.plugin.close(), 0)
        self.assert_stdout_is_json()

    def test_action_unknown(self):
        self.plugin.request("initialize", init_params())
        resp = self.plugin.request("action.run", {"locale": "fr", "action": "boom", "args": {}, "session": {"id": "s"}})
        self.assertEqual(resp["error"]["code"], -32602)
        self.assertIn("action inconnue", resp["error"]["message"])


class StdoutOnlyJsonEndToEndTest(FakeCodegraphCase):
    """Parcours complet (indexation, rendu, envoi) : chaque ligne de stdout est un message JSON-RPC."""

    def test_full_session_stdout_is_pure_json(self):
        self.cfg["affected"] = os.path.join(os.path.dirname(FAKE_CODEGRAPH), "fixtures", "affected.json")
        self.write_cfg()
        self.add_node("src/a.ts", [("alpha", "function", 10)])
        plugin = PluginProcess()
        self.addCleanup(plugin.dispose)
        plugin.request("initialize", init_params(config={"codegraph": FAKE_CODEGRAPH, "depth": 2}))
        session = self.session()
        diff = self.diff([("src/a.ts", "M")])
        first = plugin.request("panel.render", {"locale": "fr", "session": session, "diff": diff})["result"]
        self.assertEqual(first["blocks"][-1]["items"][0]["id"], "index")
        started = plugin.request("action.run", {"locale": "fr", "action": "index", "args": {}, "session": session, "diff": diff})
        self.assertIn("refresh_ms", started["result"]["document"])
        for _ in range(100):
            doc = plugin.request("panel.render", {"locale": "fr", "session": session, "diff": diff})["result"]
            if "refresh_ms" not in doc:
                break
            import time
            time.sleep(0.05)
        self.assertNotIn("refresh_ms", doc)
        sent = plugin.request("action.run", {"locale": "en", "action": "send-impact", "args": {}, "session": session, "diff": diff})
        self.assertIn("propose", sent["result"])
        plugin.request("shutdown")
        self.assertEqual(plugin.proc.wait(timeout=10), 0)
        for line in plugin.lines:
            self.assertEqual(json.loads(line.decode("utf-8"))["jsonrpc"], "2.0")


class SourceHygieneTest(unittest.TestCase):
    def test_no_shell_in_source(self):
        with open(PLUGIN_FILE, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("shell=True", src)
        self.assertNotIn("os.system", src)
        self.assertNotIn("os.popen", src)

    def test_manifest_matches_contract(self):
        with open(os.path.join(PLUGIN_DIR, "plugin.json"), encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(set(manifest), {"api_version", "name", "version", "label", "description", "command",
                                         "files", "permissions", "contributes", "config"})
        self.assertEqual(manifest["api_version"], 1)
        self.assertEqual(manifest["name"], os.path.basename(PLUGIN_DIR))
        self.assertEqual(manifest["command"], ["python3", "-I", "codegraph_impact.py"])
        self.assertEqual(manifest["files"], ["codegraph_impact.py"])
        self.assertEqual(manifest["permissions"], ["diff.read", "worktree.read", "worktree.write", "claude.propose"])
        self.assertNotIn("network", manifest["permissions"])
        self.assertEqual(manifest["config"], {"codegraph": None, "depth": 2})
        actions = {a["id"]: a for a in manifest["contributes"]["actions"]}
        self.assertEqual(set(actions), {"index", "send-impact"})
        self.assertTrue(actions["send-impact"]["propose"])
        for text in [manifest["label"], manifest["description"], manifest["contributes"]["session_tab"]["label"]]:
            self.assertEqual(set(text), {"fr", "en"})
            for value in text.values():
                self.assertNotIn("\n", value)
        self.assertLessEqual(max(len(v) for v in manifest["description"].values()), 400)
        self.assertLessEqual(max(len(v) for v in manifest["label"].values()), 64)


if __name__ == "__main__":
    unittest.main()
