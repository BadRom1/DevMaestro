"""Panneau et actions, plugin chargé en mémoire, faux ``codegraph`` en sous-processus."""

import json
import os
import stat
import subprocess
import time

from helpers import FAKE_CODEGRAPH, FakeCodegraphCase, PluginProcess, fixture, git, load_plugin_module

M = load_plugin_module()


def blocks_of(doc, kind):
    return [b for b in doc["blocks"] if b["type"] == kind]


def notices(doc, level=None):
    return [b["text"] for b in blocks_of(doc, "notice") if level is None or b["level"] == level]


class PanelCase(FakeCodegraphCase):
    def plugin(self, locale="fr", depth=2, codegraph=FAKE_CODEGRAPH):
        p = M.Plugin()
        p.initialize({"api_version": 1, "locale": locale, "config": {"codegraph": codegraph, "depth": depth},
                      "permissions": []})
        self.addCleanup(p.close)
        return p

    def render(self, plugin, files=(("src/a.ts", "M"),), locale="fr", sha=None, **diff_kw):
        return plugin.panel_render({"locale": locale, "session": self.session(),
                                    "diff": self.diff(list(files), sha=sha, **diff_kw)})


class NoCodegraphTest(PanelCase):
    def test_missing_codegraph_explains_manual_install(self):
        # Sans config.codegraph et sans `codegraph` dans le PATH (processus réel, PATH vide).
        empty = os.path.join(self.tmp, "vide")
        os.makedirs(empty)
        plugin = PluginProcess(env={"PATH": empty, "HOME": self.tmp})
        self.addCleanup(plugin.dispose)
        plugin.request("initialize", {"api_version": 1, "locale": "fr", "config": {"codegraph": None, "depth": 2}})
        doc = plugin.request("panel.render", {"locale": "fr", "session": self.session(),
                                              "diff": self.diff([("src/a.ts", "M")])})["result"]
        text = " ".join(notices(doc))
        self.assertIn("npm install -g @colbymchenry/codegraph", text)
        self.assertIn("config.codegraph", text)
        self.assertIn("jamais « codegraph install »", text)
        doc_en = plugin.request("panel.render", {"locale": "en", "session": self.session(),
                                                 "diff": self.diff([("src/a.ts", "M")])})["result"]
        self.assertIn("Install it yourself", " ".join(notices(doc_en)))
        self.assertEqual(self.calls(), [])

    def test_relative_config_path_is_rejected(self):
        doc = self.render(self.plugin(codegraph="bin/codegraph"))
        self.assertIn("chemin absolu", notices(doc, "error")[0])
        self.assertEqual(self.calls(), [])


class PreconditionsTest(PanelCase):
    def test_without_worktree(self):
        p = self.plugin()
        doc = p.panel_render({"locale": "fr", "session": {"id": "s1"}, "diff": self.diff([("a.ts", "M")])})
        self.assertIn("worktree.read", notices(doc)[0])

    def test_without_diff(self):
        p = self.plugin()
        self.make_index()
        doc = p.panel_render({"locale": "en", "session": self.session()})
        self.assertIn("diff.read", notices(doc)[0])
        self.assertEqual(self.calls(), [])

    def test_without_index_offers_index_action(self):
        doc = self.render(self.plugin())
        self.assertIn("pas encore d'index", notices(doc, "info")[0])
        actions = blocks_of(doc, "actions")[0]["items"]
        self.assertEqual([(a["id"], a["label"]) for a in actions], [("index", "Indexer")])
        self.assertEqual(self.calls(), [])

    def test_without_index_english(self):
        doc = self.render(self.plugin(), locale="en")
        self.assertEqual(blocks_of(doc, "actions")[0]["items"][0]["label"], "Index")
        self.assertEqual(doc["title"], "Diff impact")


class AnalysisTest(PanelCase):
    def setUp(self):
        super().setUp()
        self.make_index()
        self.add_node("src/a.ts", [("alpha", "function", 10), ("count", "property", 12)])
        self.add_impact("src/a.ts::alpha", fixture("impact_handmade.json"))
        self.cfg["affected"] = fixture("affected.json")
        self.write_cfg()

    def table(self, doc):
        return blocks_of(doc, "table")[0]

    def test_depths_recomputed_sorted_with_confidence(self):
        doc = self.render(self.plugin())
        rows = [(r["symbol"], r["location"], r["depth"], r["confidence"]) for r in self.table(doc)["rows"]]
        self.assertEqual(rows, [
            ("alpha", "src/a.ts:10", 0, None),
            ("beta", "src/b.ts:5", 1, 0.9),
            ("theta", "src/b.ts:40", 1, 1.0),
            ("gamma", "src/c.ts:7", 1, 0.5),
            ("a.test.ts", "test/a.test.ts:1", 1, None),
            ("eta", "src/c.ts:2", 2, "heuristique"),
            ("delta", "src/d.ts:3", 2, 0.8),  # min(0.9, 0.8) par beta, préféré au chemin heuristique
        ])
        cols = [c["id"] for c in self.table(doc)["columns"]]
        self.assertEqual(cols, ["symbol", "location", "depth", "confidence"])

    def test_depth_config_bounds_bfs_and_cli(self):
        doc = self.render(self.plugin(depth=3))
        names = [r["symbol"] for r in self.table(doc)["rows"]]
        self.assertIn("epsilon", names)
        self.assertNotIn("zeta", names)  # autre définition (autre fichier) écartée
        impact_calls = [c["argv"] for c in self.calls() if c["argv"][0] == "impact"]
        self.assertEqual(impact_calls[-1], ["impact", "-p", os.path.realpath(self.root), "-f", "src/a.ts",
                                            "--depth", "3", "--json", "--", "alpha"])
        self.render(self.plugin(depth=9))
        self.assertEqual([c["argv"] for c in self.calls() if c["argv"][0] == "impact"][-1][6], "5")
        self.render(self.plugin(depth=0))
        self.assertEqual([c["argv"] for c in self.calls() if c["argv"][0] == "impact"][-1][6], "1")

    def test_unsafe_paths_and_symbols_never_reach_codegraph(self):
        self.add_node("src/a.ts", [("alpha", "function", 10), ("-evil", "function", 20)])
        doc = self.render(self.plugin(), files=[("-rf.ts", "A"), ("src/a\nb.ts", "A"), ("src/\x1bx.ts", "A"),
                                                ("src/a.ts", "A")])
        calls = self.calls()
        self.assertEqual([c["argv"][4] for c in calls if c["argv"][0] == "node"], ["src/a.ts"])
        self.assertEqual([c["stdin"] for c in calls if c["argv"][0] == "affected"], ["src/a.ts\n"])
        impacts = [c["argv"] for c in calls if c["argv"][0] == "impact"]
        self.assertEqual([a[-2:] for a in impacts], [["--", "alpha"]])
        for c in calls:
            for arg in c["argv"][1:]:
                self.assertFalse(arg.startswith("-") and arg not in (
                    "-p", "-f", "--depth", "--json", "--stdin", "--symbols-only", "--yes", "--"), arg)
        self.assertTrue(any("4 chemin(s) ou symbole(s) ignoré(s)" in t for t in notices(doc, "warning")))
        self.assertEqual([r["symbol"] for r in self.table(doc)["rows"] if r["depth"] == 0], ["alpha"])
        self.assertTrue(M.safe_arg("src/ok-file.ts"))
        for bad in ["-x", "--help", "a\nb", "a\tb", "a\x00b", "a\u202eb", "", None]:
            self.assertFalse(M.safe_arg(bad), bad)

    def test_real_fixture_impact(self):
        self.add_node("app/src/renderer/src/state/aiReview.ts", [("cut", "function", 75)])
        self.add_impact("cut", fixture("impact_cut.json"))
        doc = self.render(self.plugin(), files=[("app/src/renderer/src/state/aiReview.ts", "A")])
        rows = {r["symbol"]: r for r in self.table(doc)["rows"]}
        self.assertEqual(rows["cut"]["depth"], 0)
        self.assertEqual(rows["reviewSubject"]["depth"], 1)
        self.assertEqual(rows["AiReviewProvider"]["depth"], 2)
        self.assertEqual(rows["reviewSubject"]["confidence"], 0.9)

    def test_parse_real_symbols_output(self):
        with open(fixture("node_symbols_aiReview.md"), encoding="utf-8") as f:
            symbols = M.parse_symbols(f.read())
        self.assertEqual(len(symbols), 74)
        self.assertIn(("reviewSubject", "function", 81), symbols)
        self.assertIn(("encoder", "constant", 200), symbols)

    def test_affected_tests_listed(self):
        doc = self.render(self.plugin())
        lst = blocks_of(doc, "list")[0]
        self.assertTrue(lst["title"].startswith("Tests affectés (53)"))
        self.assertIn({"text": "app/test/ai-review.test.ts"}, lst["items"])
        call = [c for c in self.calls() if c["argv"][0] == "affected"][0]
        self.assertEqual(call["argv"], ["affected", "--stdin", "--json", "-p", os.path.realpath(self.root)])
        self.assertEqual(call["stdin"], "src/a.ts\n")
        actions = [a["id"] for a in blocks_of(doc, "actions")[0]["items"]]
        self.assertEqual(actions, ["index", "send-impact"])
        self.assertEqual(blocks_of(doc, "actions")[0]["items"][0]["label"], "Mettre à jour")

    def test_affected_failure_is_a_warning(self):
        self.cfg["affected"] = "fail"
        self.write_cfg()
        doc = self.render(self.plugin())
        self.assertTrue(any("Tests affectés indisponibles" in t for t in notices(doc, "warning")))
        self.assertTrue(blocks_of(doc, "table"))

    def test_deleted_files_skipped_and_rust_warning(self):
        doc = self.render(self.plugin(), files=[("src/a.ts", "M"), ("crates/x/src/lib.rs", "D")])
        self.assertTrue(any("Rust mal couvert" in t for t in notices(doc, "warning")))
        node_files = [c["argv"][4] for c in self.calls() if c["argv"][0] == "node"]
        self.assertEqual(node_files, ["src/a.ts"])
        doc = self.render(self.plugin(), files=[("src/a.ts", "M")])
        self.assertFalse(any("Rust" in t for t in notices(doc)))

    def test_telemetry_env_and_no_shell(self):
        self.render(self.plugin())
        calls = self.calls()
        self.assertTrue(calls)
        for c in calls:
            self.assertEqual(c["env"]["DO_NOT_TRACK"], "1")
            self.assertEqual(c["env"]["CODEGRAPH_TELEMETRY"], "0")
            self.assertEqual(c["env"]["CODEGRAPH_NO_UPDATE_CHECK"], "1")
            self.assertEqual(c["env"]["CODEGRAPH_NO_DAEMON"], "1")
            self.assertEqual(c["env"]["CODEGRAPH_NO_DOWNLOAD"], "1")
            self.assertNotIn("install", c["argv"])
            self.assertNotIn(c["ppid_comm"], ("sh", "bash", "dash", "zsh", "fish"))
            self.assertEqual(c["cwd"], os.path.realpath(self.root))

    def test_english_locale(self):
        doc = self.render(self.plugin(), locale="en", files=[("src/a.ts", "M"), ("src/m.rs", "M")])
        self.assertEqual(doc["title"], "Diff impact")
        self.assertEqual(self.table(doc)["columns"][0]["label"], "Symbol")
        self.assertTrue(any("Rust is poorly covered" in t for t in notices(doc, "warning")))
        rows = {r["symbol"]: r for r in self.table(doc)["rows"]}
        self.assertEqual(rows["eta"]["confidence"], "heuristic")

    def test_send_impact_proposes_markdown(self):
        p = self.plugin()
        res = p.action_run({"locale": "fr", "action": "send-impact", "args": {}, "session": self.session(),
                            "diff": self.diff([("src/a.ts", "M"), ("src/lib.rs", "M")])})
        content = res["propose"]["content"]
        self.assertTrue(content.startswith("# Impact du diff"))
        self.assertIn("Branche : `feature`", content)
        self.assertIn("- `alpha` — `src/a.ts:10`", content)
        self.assertIn("`delta` — `src/d.ts:3` — profondeur 2 — confiance 0.8", content)
        self.assertIn("## Tests affectés", content)
        self.assertIn("- `app/test/ai-review.test.ts`", content)
        self.assertIn("Rust mal couvert", content)
        self.assertLessEqual(len(content), 100_000)
        self.assertEqual(res["document"]["title"], "Impact du diff")

    def test_send_impact_reuses_recent_analysis(self):
        p = self.plugin()
        params = {"locale": "fr", "session": self.session(), "diff": self.diff([("src/a.ts", "M")])}
        p.panel_render(params)
        before = len(self.calls())
        p.action_run(dict(params, action="send-impact", args={}))
        self.assertEqual(len(self.calls()), before)

    def test_send_impact_without_index_returns_document_only(self):
        os.rmdir(os.path.join(self.root, ".codegraph"))
        res = self.plugin().action_run({"locale": "en", "action": "send-impact", "args": {},
                                        "session": self.session(), "diff": self.diff([("src/a.ts", "M")])})
        self.assertNotIn("propose", res)
        self.assertIn("no CodeGraph index", notices(res["document"])[0])

    def test_unknown_symbol_output_is_not_json(self):
        self.add_node("src/b.ts", [("ghost", "function", 3)])
        doc = self.render(self.plugin(), files=[("src/b.ts", "M")])
        rows = self.table(doc)["rows"]
        self.assertEqual(rows, [{"symbol": "ghost", "location": "src/b.ts:3", "depth": 0, "confidence": None}])

    def test_changed_lines_select_symbols(self):
        # Vrai dépôt : seules les lignes modifiées depuis la base désignent les symboles.
        git(self.root, "init", "-q", "-b", "main")
        os.makedirs(os.path.join(self.root, "src"))
        path = os.path.join(self.root, "src", "a.ts")
        lines = [f"// ligne {i}" for i in range(1, 41)]
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        git(self.root, "add", ".")
        git(self.root, "commit", "-q", "-m", "base")
        sha = git(self.root, "rev-parse", "HEAD").strip()
        lines[21] = "// modifiée"  # ligne 22, dans `second` (20..29)
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        self.add_node("src/a.ts", [("first", "function", 10), ("second", "function", 20),
                                   ("inner", "property", 23), ("third", "function", 30)])
        doc = self.render(self.plugin(), sha=sha)
        self.assertEqual([r["symbol"] for r in self.table(doc)["rows"]], ["second"])
        # Fichier ajouté : tous les symboles (hors propriétés).
        doc = self.render(self.plugin(), files=[("src/a.ts", "A")], sha=sha)
        self.assertEqual([r["symbol"] for r in self.table(doc)["rows"]], ["first", "second", "third"])


class BoundsTest(PanelCase):
    def setUp(self):
        super().setUp()
        self.make_index()

    def test_symbol_cap(self):
        self.add_node("src/many.ts", [(f"f{i:02d}", "function", i + 1) for i in range(55)])
        doc = self.render(self.plugin(), files=[("src/many.ts", "M")])
        self.assertEqual(len(blocks_of(doc, "table")[0]["rows"]), 40)
        self.assertTrue(any("Plus de 40 symboles" in t for t in notices(doc, "info")))
        self.assertEqual(len([c for c in self.calls() if c["argv"][0] == "impact"]), 40)

    def test_row_cap(self):
        nodes = [{"id": "root", "name": "big", "kind": "function", "filePath": "src/big.ts", "startLine": 1}]
        edges = []
        for i in range(1200):
            nodes.append({"id": f"n{i}", "name": f"caller{i:04d}", "kind": "function", "filePath": "src/c.ts",
                          "startLine": i + 1})
            edges.append({"source": f"n{i}", "target": "root", "metadata": {"confidence": 1}, "provenance": None})
        src = self.write_json("big.json", {"definitions": [{"definition": nodes[0], "roots": ["root"],
                                                             "affected": nodes, "edges": edges}]})
        self.add_node("src/big.ts", [("big", "function", 1)])
        self.add_impact("big", src)
        doc = self.render(self.plugin(), files=[("src/big.ts", "M")])
        self.assertEqual(len(blocks_of(doc, "table")[0]["rows"]), 1000)
        self.assertTrue(any("Plus de 1000" in t for t in notices(doc, "info")))
        self.assertLess(len(json.dumps(doc, ensure_ascii=False).encode()), 1024 * 1024)

    def test_long_texts_are_truncated(self):
        long_name = "x" * 3000
        nodes = [{"id": "r", "name": "short", "kind": "function", "filePath": "src/s.ts", "startLine": 1},
                 {"id": "l", "name": long_name + "‮\x07", "kind": "function", "filePath": "src/" + "d/" * 1500 + "f.ts",
                  "startLine": 2}]
        src = self.write_json("long.json", {"definitions": [{"definition": nodes[0], "roots": ["r"], "affected": nodes,
                                                              "edges": [{"source": "l", "target": "r"}]}]})
        self.add_node("src/s.ts", [("short", "function", 1)])
        self.add_impact("short", src)
        doc = self.render(self.plugin(), files=[("src/s.ts", "M")])
        for row in blocks_of(doc, "table")[0]["rows"]:
            for value in row.values():
                if isinstance(value, str):
                    self.assertLessEqual(len(value), 2000)
                    self.assertNotIn("‮", value)
                    self.assertNotIn("\x07", value)

    def test_document_size_guard(self):
        old = M.MAX_DOC_BYTES
        M.MAX_DOC_BYTES = 3000
        self.addCleanup(setattr, M, "MAX_DOC_BYTES", old)
        self.add_node("src/many.ts", [(f"function_name_{i:02d}", "function", i + 1) for i in range(30)])
        doc = self.render(self.plugin(), files=[("src/many.ts", "M")])
        self.assertLess(len(blocks_of(doc, "table")[0]["rows"]), 30)
        self.assertTrue(any("trop volumineux" in t for t in notices(doc, "info")))
        self.assertLessEqual(len(json.dumps(doc, ensure_ascii=False).encode()), 3000)

    def test_render_budget_gives_partial_result(self):
        old = M.RENDER_BUDGET_S
        M.RENDER_BUDGET_S = 3.0
        self.addCleanup(setattr, M, "RENDER_BUDGET_S", old)
        self.cfg["impact_sleep"] = 0.4
        self.write_cfg()
        self.add_node("src/many.ts", [(f"f{i:02d}", "function", i + 1) for i in range(20)])
        started = time.monotonic()
        doc = self.render(self.plugin(), files=[("src/many.ts", "M")])
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue(any("résultat partiel" in t for t in notices(doc, "warning")))
        self.assertLess(len(blocks_of(doc, "table")[0]["rows"]), 20)

    def test_hanging_call_is_killed_within_budget(self):
        old = M.RENDER_BUDGET_S
        M.RENDER_BUDGET_S = 4.0
        self.addCleanup(setattr, M, "RENDER_BUDGET_S", old)
        self.cfg["impact_sleep"] = 60
        self.write_cfg()
        self.add_node("src/two.ts", [("one", "function", 1), ("two", "function", 2)])
        started = time.monotonic()
        doc = self.render(self.plugin(), files=[("src/two.ts", "M")])
        self.assertLess(time.monotonic() - started, M.RENDER_BUDGET_S + 1.0)
        self.assertTrue(any("résultat partiel" in t for t in notices(doc, "warning")))

    def test_default_budget_leaves_margin_under_host_timeout(self):
        self.assertLessEqual(M.RENDER_BUDGET_S + M.CALL_MARGIN_S + 2 * M.JOIN_TIMEOUT_S, 25)

    def test_propose_content_cap(self):
        nodes = [{"id": "root", "name": "big", "kind": "function", "filePath": "src/big.ts", "startLine": 1}]
        edges = []
        for i in range(999):
            nodes.append({"id": f"n{i}", "name": "c" * 150 + str(i), "kind": "function", "filePath": "src/c.ts",
                          "startLine": i + 1})
            edges.append({"source": f"n{i}", "target": "root"})
        src = self.write_json("big.json", {"definitions": [{"definition": nodes[0], "roots": ["root"],
                                                             "affected": nodes, "edges": edges}]})
        self.add_node("src/big.ts", [("big", "function", 1)])
        self.add_impact("big", src)
        res = self.plugin().action_run({"locale": "fr", "action": "send-impact", "args": {}, "session": self.session(),
                                        "diff": self.diff([("src/big.ts", "M")])})
        content = res["propose"]["content"]
        self.assertLessEqual(len(content), 100_000)
        self.assertIn("Contenu tronqué", content)
        line = json.dumps({"jsonrpc": "2.0", "id": 1, "result": res}, ensure_ascii=False).encode("utf-8")
        self.assertLess(len(line), 1024 * 1024)

    def test_send_impact_drops_document_when_line_too_big(self):
        old = M.MAX_DOC_BYTES
        M.MAX_DOC_BYTES = 2500
        self.addCleanup(setattr, M, "MAX_DOC_BYTES", old)
        self.add_node("src/many.ts", [(f"function_name_{i:02d}", "function", i + 1) for i in range(30)])
        res = self.plugin().action_run({"locale": "fr", "action": "send-impact", "args": {},
                                        "session": self.session(), "diff": self.diff([("src/many.ts", "M")])})
        self.assertIn("propose", res)
        self.assertNotIn("document", res)


class FakeIsExecutableTest(FakeCodegraphCase):
    def assert_only_read_subcommands(self):
        # Ici `install` est appelé exprès : la garde des autres tests doit le voir.
        with self.assertRaises(AssertionError):
            super().assert_only_read_subcommands()

    def test_fake_is_executable(self):
        self.assertTrue(os.stat(FAKE_CODEGRAPH).st_mode & stat.S_IXUSR)
        out = subprocess.run([FAKE_CODEGRAPH, "install"], capture_output=True)
        self.assertEqual(out.returncode, 99)


if __name__ == "__main__":
    import unittest
    unittest.main()
