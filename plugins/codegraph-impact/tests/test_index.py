"""Indexation en arrière-plan et exclusion git (``info/exclude`` du common dir)."""

import os
import time

from helpers import FAKE_CODEGRAPH, FakeCodegraphCase, git, load_plugin_module, snapshot

M = load_plugin_module()


def notices(doc, level=None):
    return [b["text"] for b in doc["blocks"] if b["type"] == "notice" and (level is None or b["level"] == level)]


class IndexCase(FakeCodegraphCase):
    def plugin(self, locale="fr"):
        p = M.Plugin()
        p.initialize({"api_version": 1, "locale": locale, "config": {"codegraph": FAKE_CODEGRAPH, "depth": 2}})
        self.addCleanup(p.close)
        return p

    def params(self, root=None, locale="fr", **kw):
        out = {"locale": locale, "session": self.session(root), "diff": self.diff([("src/a.ts", "M")])}
        out.update(kw)
        return out

    def wait_done(self, plugin, root=None, timeout=10):
        root = os.path.realpath(root or self.root)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if plugin.indexers[root].snapshot()["finished"]:
                return
            time.sleep(0.05)
        self.fail("indexation non terminée")

    def init_repo(self, path):
        git(path, "init", "-q", "-b", "main")
        with open(os.path.join(path, "a.txt"), "w") as f:
            f.write("a\n")
        git(path, "add", "a.txt")
        git(path, "commit", "-q", "-m", "init")


class BackgroundIndexTest(IndexCase):
    def test_index_runs_in_background_with_progress(self):
        self.cfg["index_sleep"] = 2.0
        self.write_cfg()
        p = self.plugin()
        started = time.monotonic()
        res = p.action_run(dict(self.params(), action="index", args={}))
        self.assertLess(time.monotonic() - started, 1.0)  # rend la main aussitôt
        doc = res["document"]
        self.assertEqual(doc["refresh_ms"], 2000)
        self.assertIn("Indexation en cours", notices(doc)[0])
        # Attend qu'une étape de progression apparaisse (démarrage de Python parfois lent).
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            during = p.panel_render(self.params())
            text = notices(during, "info")[0]
            if text.endswith("..."):
                break
            time.sleep(0.05)
        self.assertEqual(during["refresh_ms"], 2000)
        self.assertRegex(text, r"Indexation en cours… \(\d+ s\)")
        self.assertRegex(text, r"(Scanning files|Parsing code|Resolving refs)\.\.\.$")
        self.assertNotIn("\x1b", text)
        # Une seconde demande pendant l'indexation ne lance pas un second processus.
        again = p.action_run(dict(self.params(), action="index", args={}))
        self.assertIn("refresh_ms", again["document"])
        self.wait_done(p)
        argvs = [c["argv"] for c in self.calls() if c["argv"][0] in ("init", "sync", "index")]
        self.assertEqual(argvs, [["init", "--yes", os.path.realpath(self.root)]])
        after = p.panel_render(self.params())
        self.assertNotIn("refresh_ms", after)
        self.assertTrue(os.path.isdir(os.path.join(self.root, ".codegraph")))

    def test_update_uses_sync_then_full_index(self):
        self.make_index()
        p = self.plugin()
        p.action_run(dict(self.params(), action="index", args={}))
        self.wait_done(p)
        p.action_run(dict(self.params(), action="index", args={"full": True}))
        self.wait_done(p)
        argvs = [c["argv"][0] for c in self.calls() if c["argv"][0] in ("init", "sync", "index")]
        self.assertEqual(argvs, ["sync", "index"])
        for c in self.calls():
            self.assertEqual(c["env"]["DO_NOT_TRACK"], "1")
            self.assertEqual(c["env"]["CODEGRAPH_TELEMETRY"], "0")
            self.assertNotIn("install", c["argv"])

    def test_index_failure_is_an_error_notice(self):
        self.cfg["index_rc"] = 3
        self.write_cfg()
        p = self.plugin(locale="en")
        p.action_run(dict(self.params(locale="en"), action="index", args={}))
        self.wait_done(p)
        doc = p.panel_render(self.params(locale="en"))
        errors = notices(doc, "error")
        self.assertEqual(len(errors), 1)
        self.assertIn("Indexing failed (code 3)", errors[0])
        self.assertIn("disk full", errors[0])
        self.assertNotIn("refresh_ms", doc)
        self.assertEqual(doc["blocks"][-1]["items"][0]["id"], "index")

    def test_index_without_diff_still_possible(self):
        p = self.plugin()
        res = p.action_run({"locale": "fr", "action": "index", "args": {}, "session": self.session()})
        self.assertIn("refresh_ms", res["document"])
        self.wait_done(p)

    def test_progress_line_cleaning(self):
        with open(os.path.join(os.path.dirname(FAKE_CODEGRAPH), "fixtures", "init.log"), encoding="utf-8") as f:
            log = f.read()
        self.assertEqual(M.progress_line(log), "Done")
        self.assertEqual(M.progress_line(log.split("Resolving")[0]), "Parsing code...")
        self.assertEqual(M.progress_line("\x1b[32m◒  Parsing 12/355\x1b[0m\r◐  Parsing 40/355"), "Parsing 40/355")


class GitExcludeTest(IndexCase):
    def exclude_lines(self, repo):
        path = os.path.join(repo, ".git", "info", "exclude")
        with open(path, encoding="utf-8") as f:
            return f.read().splitlines()

    def test_exclude_is_idempotent_and_nothing_else_changes(self):
        self.init_repo(self.root)
        os.remove(os.path.join(self.root, ".git", "info", "exclude"))
        os.rmdir(os.path.join(self.root, ".git", "info"))  # `info/` absent : recréé
        before = snapshot(self.root)
        p = self.plugin()
        p.action_run(dict(self.params(), action="index", args={}))
        self.wait_done(p)
        p.action_run(dict(self.params(), action="index", args={}))
        self.wait_done(p)
        self.assertEqual(self.exclude_lines(self.root).count("/.codegraph/"), 1)
        after = snapshot(self.root)
        changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
        self.assertEqual({k for k in changed if not k.startswith(".codegraph" + os.sep)},
                         {os.path.join(".git", "info", "exclude")})
        self.assertEqual(git(self.root, "status", "--porcelain"), "")

    def test_existing_exclude_content_kept(self):
        self.init_repo(self.root)
        path = os.path.join(self.root, ".git", "info", "exclude")
        with open(path, "w") as f:
            f.write("# perso\n*.log")  # sans saut de ligne final
        M.ensure_git_exclude(self.root)
        M.ensure_git_exclude(self.root)
        with open(path) as f:
            self.assertEqual(f.read(), "# perso\n*.log\n/.codegraph/\n")
        mtime = os.stat(path).st_mtime_ns
        time.sleep(0.01)
        M.ensure_git_exclude(self.root)
        self.assertEqual(os.stat(path).st_mtime_ns, mtime)  # ligne présente : rien n'est écrit

    def test_linked_worktree_writes_to_common_dir(self):
        main = os.path.join(self.tmp, "main")
        os.makedirs(main)
        self.init_repo(main)
        linked = os.path.join(self.tmp, "linked")
        git(main, "worktree", "add", "-q", "-b", "topic", linked)
        before_main = snapshot(main)
        before_linked = snapshot(linked)
        p = self.plugin()
        p.action_run(dict(self.params(root=linked), action="index", args={}))
        self.wait_done(p, root=linked)
        self.assertEqual(self.exclude_lines(main).count("/.codegraph/"), 1)
        self.assertFalse(os.path.exists(os.path.join(main, ".git", "worktrees", "linked", "info", "exclude")))
        after_main = snapshot(main)
        changed_main = {k for k in set(before_main) | set(after_main) if before_main.get(k) != after_main.get(k)}
        self.assertEqual(changed_main, {os.path.join(".git", "info", "exclude")})
        after_linked = snapshot(linked)
        changed_linked = {k for k in set(before_linked) | set(after_linked)
                          if before_linked.get(k) != after_linked.get(k)}
        self.assertTrue(changed_linked)
        self.assertTrue(all(k.startswith(".codegraph" + os.sep) for k in changed_linked), changed_linked)
        self.assertEqual(git(linked, "status", "--porcelain"), "")

    def test_no_index_when_exclude_cannot_be_written(self):
        self.init_repo(self.root)
        exclude = os.path.join(self.root, ".git", "info", "exclude")
        os.remove(exclude)
        os.makedirs(exclude)  # `info/exclude` est un dossier : écriture impossible, même en root
        p = self.plugin()
        res = p.action_run(dict(self.params(), action="index", args={}))
        doc = res["document"]
        self.assertNotIn("refresh_ms", doc)
        errors = notices(doc, "error")
        self.assertEqual(len(errors), 1)
        self.assertIn("Indexation annulée", errors[0])
        self.assertIn("info/exclude", errors[0])
        self.assertEqual(self.calls(), [])  # aucun `codegraph init`
        self.assertFalse(os.path.exists(os.path.join(self.root, ".codegraph")))
        self.assertNotIn(os.path.realpath(self.root), p.indexers)

    def test_broken_git_dir_blocks_index(self):
        with open(os.path.join(self.root, ".git"), "w") as f:
            f.write("gitdir: /nulle/part\n")  # worktree lié cassé : git échoue, `.git` existe
        res = self.plugin(locale="en").action_run(dict(self.params(locale="en"), action="index", args={}))
        self.assertIn("Indexing cancelled", notices(res["document"], "error")[0])
        self.assertEqual(self.calls(), [])

    def test_outside_git_repository(self):
        self.assertIsNone(M.ensure_git_exclude(self.root))
        self.assertEqual(os.listdir(self.root), [])


if __name__ == "__main__":
    import unittest
    unittest.main()
