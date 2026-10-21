"""Plugin de référence DevMaestro : impact du diff d'une session, calculé par CodeGraph.

Contrat : lot 22a (docs/v0.3.md, « Contrat du lot 22a ») et ADR 0007.

Transport : JSON-RPC 2.0, un message JSON par ligne (NDJSON, UTF-8) sur stdin/stdout.
stdout ne porte QUE des réponses ; les journaux vont sur stderr.

Méthodes reçues : ``initialize``, ``panel.render``, ``action.run``, ``shutdown``.

CodeGraph est la CLI de l'utilisateur (``config.codegraph`` ou ``codegraph`` dans le
PATH) : jamais installée ni mise à jour par ce plugin, jamais ``codegraph install``.
Chaque appel est lancé sans shell, avec la télémétrie coupée, un délai et une sortie
bornée. L'index vit dans ``<worktree>/.codegraph/`` ; la seule écriture hors de ce
dossier est la ligne ``/.codegraph/`` ajoutée une fois à ``<git-common-dir>/info/exclude``.

Bibliothèque standard seulement : le fichier est lancé par ``python3 -I`` et n'importe
rien d'autre du dossier du plugin.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback

API_VERSION = 1
PLUGIN_VERSION = "0.1.0"

# Bornes du contrat (documents déclaratifs) et du plugin de référence.
MAX_SYMBOLS = 40
MAX_ROWS = 1000
MAX_LIST_ITEMS = 500
# Budget d'un rendu : l'hôte coupe `panel.render` à 30 s ; marge pour la fin d'un appel tué
# (au plus ~1 s, comptée dans le budget) et la mise en forme.
RENDER_BUDGET_S = 22.0
CALL_MARGIN_S = 1.0
JOIN_TIMEOUT_S = 0.5
CALL_TIMEOUT_S = 10.0
GIT_TIMEOUT_S = 5.0
INDEX_TIMEOUT_S = 30 * 60.0
MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024
MAX_DOC_BYTES = 900 * 1024  # une ligne du transport fait 1 Mio au plus
MAX_PROPOSE_CHARS = 100_000
MAX_DIFF_FILES = 200
REFRESH_MS = 2000
DEFAULT_DEPTH = 2

# Sortes de symboles trop fines pour être des « symboles touchés » (champs, imports,
# variables locales…) : le changement est rattaché au symbole englobant.
SKIPPED_KINDS = {"property", "field", "import", "variable", "parameter", "enum_member", "file"}

# Environnement des appels à CodeGraph : celui du plugin, télémétrie et réseau coupés.
CODEGRAPH_ENV_OVERRIDES = {
    "DO_NOT_TRACK": "1",
    "CODEGRAPH_TELEMETRY": "0",
    "CODEGRAPH_NO_UPDATE_CHECK": "1",
    "CODEGRAPH_NO_DAEMON": "1",
    "CODEGRAPH_NO_DOWNLOAD": "1",
    "NO_COLOR": "1",
}
GIT_ENV_OVERRIDES = {"GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"}
GIT_SAFE_OPTIONS = ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "--no-optional-locks"]

EXCLUDE_LINE = "/.codegraph/"

TEXTS = {
    "fr": {
        "title": "Impact du diff",
        "no_worktree": "Le dossier de la session n'est pas fourni : le plugin a besoin de la permission « worktree.read ».",
        "worktree_gone": "Le dossier de la session est introuvable : {path}",
        "no_diff": "Pas de diff pour cette session : hors d'un dépôt git, ou permission « diff.read » absente.",
        "no_codegraph": "CodeGraph est introuvable. Installe-le toi-même (« npm install -g @colbymchenry/codegraph », jamais « codegraph install ») ou renseigne le chemin absolu de l'exécutable dans « config.codegraph » du manifeste plugin.json (modifier le manifeste redemande ton accord).",
        "bad_codegraph": "« config.codegraph » doit être le chemin absolu d'un exécutable : {path}",
        "no_index": "Ce worktree n'a pas encore d'index CodeGraph. L'indexation crée « .codegraph/ » (environ 42 Mo pour un dépôt de 350 fichiers), exclu de git par « info/exclude ».",
        "index": "Indexer",
        "update": "Mettre à jour",
        "send": "Envoyer l'impact à Claude",
        "indexing": "Indexation en cours… ({elapsed} s)",
        "indexing_started": "Indexation lancée en arrière-plan.",
        "index_failed": "L'indexation a échoué (code {code}) : {detail}",
        "index_timeout": "L'indexation a dépassé {minutes} min : arrêtée.",
        "index_done": "Index à jour.",
        "launch_failed": "Impossible de lancer CodeGraph : {detail}",
        "rust": "Rust mal couvert par CodeGraph : les appels entre fichiers Rust sont souvent manqués, l'impact affiché peut être incomplet.",
        "too_many_symbols": "Plus de {max} symboles touchés : seuls les {max} premiers sont analysés.",
        "too_many_rows": "Plus de {max} éléments impactés : le tableau est tronqué.",
        "doc_too_big": "Résultat trop volumineux : le tableau est réduit à {rows} lignes.",
        "budget": "Analyse arrêtée après {seconds} s : résultat partiel.",
        "diff_truncated": "Le diff fourni par DevMaestro est tronqué : l'analyse est partielle.",
        "no_files": "Aucun fichier modifié à analyser dans le diff.",
        "no_symbols": "Aucun symbole reconnu par CodeGraph dans les lignes modifiées.",
        "tests_failed": "Tests affectés indisponibles : {detail}",
        "unsafe": "{count} chemin(s) ou symbole(s) ignoré(s) : ils commencent par « - » ou contiennent des caractères de contrôle.",
        "exclude_failed": "Indexation annulée : impossible d'ajouter « /.codegraph/ » à « info/exclude » du dépôt git ({detail}). Sans cette ligne, l'index apparaîtrait dans « git status ».",
        "symbols_failed": "Symboles indisponibles pour {count} fichier(s) (CodeGraph n'a rien rendu).",
        "summary": "**{symbols}** symbole(s) touché(s) dans **{files}** fichier(s) ; **{dependents}** élément(s) dépendant(s) jusqu'à la profondeur **{depth}** ; **{tests}** test(s) affecté(s).",
        "table_caption": "Symboles touchés (profondeur 0) et ce qui en dépend",
        "col_symbol": "Symbole",
        "col_location": "Fichier:ligne",
        "col_depth": "Profondeur",
        "col_confidence": "Confiance",
        "heuristic": "heuristique",
        "tests_title": "Tests affectés ({count})",
        "no_tests": "Aucun test affecté.",
        "md_title": "Impact du diff (CodeGraph)",
        "md_branch": "Branche : `{branch}`",
        "md_touched": "Symboles touchés",
        "md_dependents": "Éléments dépendants (profondeur ≤ {depth})",
        "md_tests": "Tests affectés",
        "md_none": "_Aucun._",
        "md_depth": "profondeur {depth}",
        "md_confidence": "confiance {value}",
        "md_truncated": "_Contenu tronqué._",
        "md_partial": "_Résultat partiel : {reason}_",
        "md_note": "Calculé par CodeGraph à partir du graphe d'appels ; les arêtes « heuristique » et le code Rust peuvent manquer ou être inexacts.",
        "unknown_action": "action inconnue : {action}",
        "unknown_method": "méthode inconnue : {method}",
        "bad_api": "api_version {value} non prise en charge (attendue : 1)",
        "internal": "erreur interne du plugin : {detail}",
    },
    "en": {
        "title": "Diff impact",
        "no_worktree": "The session folder is not provided: the plugin needs the “worktree.read” permission.",
        "worktree_gone": "The session folder cannot be found: {path}",
        "no_diff": "No diff for this session: outside a git repository, or the “diff.read” permission is missing.",
        "no_codegraph": "CodeGraph cannot be found. Install it yourself (“npm install -g @colbymchenry/codegraph”, never “codegraph install”) or set the absolute path of the executable in “config.codegraph” of the plugin.json manifest (changing the manifest asks for your approval again).",
        "bad_codegraph": "“config.codegraph” must be the absolute path of an executable: {path}",
        "no_index": "This worktree has no CodeGraph index yet. Indexing creates “.codegraph/” (about 42 MB for a 350-file repository), excluded from git through “info/exclude”.",
        "index": "Index",
        "update": "Update",
        "send": "Send the impact to Claude",
        "indexing": "Indexing… ({elapsed} s)",
        "indexing_started": "Indexing started in the background.",
        "index_failed": "Indexing failed (code {code}): {detail}",
        "index_timeout": "Indexing took more than {minutes} min: stopped.",
        "index_done": "Index up to date.",
        "launch_failed": "Cannot launch CodeGraph: {detail}",
        "rust": "Rust is poorly covered by CodeGraph: calls between Rust files are often missed, the impact shown may be incomplete.",
        "too_many_symbols": "More than {max} touched symbols: only the first {max} are analysed.",
        "too_many_rows": "More than {max} impacted items: the table is truncated.",
        "doc_too_big": "Result too large: the table is reduced to {rows} rows.",
        "budget": "Analysis stopped after {seconds} s: partial result.",
        "diff_truncated": "The diff provided by DevMaestro is truncated: the analysis is partial.",
        "no_files": "No modified file to analyse in the diff.",
        "no_symbols": "No symbol recognised by CodeGraph in the modified lines.",
        "tests_failed": "Affected tests unavailable: {detail}",
        "unsafe": "{count} path(s) or symbol(s) ignored: they start with “-” or contain control characters.",
        "exclude_failed": "Indexing cancelled: cannot add “/.codegraph/” to the git repository's “info/exclude” ({detail}). Without this line, the index would show up in “git status”.",
        "symbols_failed": "Symbols unavailable for {count} file(s) (CodeGraph returned nothing).",
        "summary": "**{symbols}** touched symbol(s) in **{files}** file(s); **{dependents}** dependent item(s) up to depth **{depth}**; **{tests}** affected test(s).",
        "table_caption": "Touched symbols (depth 0) and what depends on them",
        "col_symbol": "Symbol",
        "col_location": "File:line",
        "col_depth": "Depth",
        "col_confidence": "Confidence",
        "heuristic": "heuristic",
        "tests_title": "Affected tests ({count})",
        "no_tests": "No affected test.",
        "md_title": "Diff impact (CodeGraph)",
        "md_branch": "Branch: `{branch}`",
        "md_touched": "Touched symbols",
        "md_dependents": "Dependent items (depth ≤ {depth})",
        "md_tests": "Affected tests",
        "md_none": "_None._",
        "md_depth": "depth {depth}",
        "md_confidence": "confidence {value}",
        "md_truncated": "_Content truncated._",
        "md_partial": "_Partial result: {reason}_",
        "md_note": "Computed by CodeGraph from the call graph; “heuristic” edges and Rust code may be missing or inaccurate.",
        "unknown_action": "unknown action: {action}",
        "unknown_method": "unknown method: {method}",
        "bad_api": "api_version {value} not supported (expected: 1)",
        "internal": "internal plugin error: {detail}",
    },
}


def log(message):
    """Journal sur stderr (jamais sur stdout, réservé au protocole)."""
    try:
        sys.stderr.write(f"[codegraph-impact] {message}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


# --------------------------------------------------------------------------- texte

_INVISIBLE_RE = re.compile(
    "[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]"
)
_CONTROL_RE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
# Cadres et puces de la sortie « clack » de CodeGraph (┌ │ ◆ ● └ …) et indicateurs animés.
_DECOR_RE = re.compile("^[\\s─-╿■-◿⠀-⣿←-⇿✓✔✖✗]+")


def clean(text, limit, multiline=False):
    """Texte tiers nettoyé (invisibles, contrôles) puis tronqué à ``limit`` caractères."""
    if text is None:
        return ""
    text = str(text)
    text = _INVISIBLE_RE.sub("", text)
    text = text.replace("\t", " ").replace("\r\n", "\n").replace("\r", "\n")
    if not multiline:
        text = text.replace("\n", " ")
    text = _CONTROL_RE.sub("", text)
    if len(text) > limit:
        text = text[: max(0, limit - 1)] + "…"
    return text


def progress_line(raw):
    """Dernière ligne utile d'une sortie de CodeGraph, sans couleurs ni décor."""
    text = _ANSI_RE.sub("", raw)
    best = ""
    for line in re.split(r"[\r\n]+", text):
        line = _DECOR_RE.sub("", line).strip()
        if line:
            best = line
    return clean(best, 300)


# --------------------------------------------------------------------- sous-processus

class LaunchError(Exception):
    """Le programme n'a pas pu être lancé (introuvable, non exécutable…)."""


class RunResult:
    def __init__(self, code, out, err, timed_out, truncated):
        self.code = code
        self.out = out
        self.err = err
        self.timed_out = timed_out
        self.truncated = truncated

    @property
    def ok(self):
        return self.code == 0 and not self.timed_out and not self.truncated

    def text(self):
        return self.out.decode("utf-8", errors="replace")

    def detail(self):
        if self.timed_out:
            return "timeout"
        if self.truncated:
            return f"output > {MAX_OUTPUT_BYTES // (1024 * 1024)} MiB"
        tail = self.err.decode("utf-8", errors="replace").strip() or self.text().strip()
        return clean(progress_line(tail[-2000:]) or f"code {self.code}", 300)


def _env(overrides):
    env = dict(os.environ)
    env.update(CODEGRAPH_ENV_OVERRIDES)
    env.update(overrides)
    return env


def _kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _drain(stream, sink, limit, flags):
    """Lit un tube jusqu'au bout ; garde ``limit`` octets, jette le reste."""
    try:
        while True:
            chunk = stream.read(65536)
            if not chunk:
                break
            room = limit - len(sink)
            if room > 0:
                sink.extend(chunk[:room])
            if len(chunk) > room:
                flags["truncated"] = True
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass


def run(argv, cwd, timeout, stdin_data=None, env_overrides=None, limit=MAX_OUTPUT_BYTES):
    """Lance ``argv`` sans shell, avec délai et sortie bornée."""
    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_env(env_overrides or {}),
            start_new_session=True,
            close_fds=True,
            shell=False,
        )
    except OSError as e:
        raise LaunchError(str(e)) from e
    out, err = bytearray(), bytearray()
    out_flags, err_flags = {}, {}
    readers = [
        threading.Thread(target=_drain, args=(proc.stdout, out, limit, out_flags), daemon=True),
        threading.Thread(target=_drain, args=(proc.stderr, err, MAX_STDERR_BYTES, err_flags), daemon=True),
    ]
    for t in readers:
        t.start()
    if stdin_data is not None:
        def feed():
            try:
                proc.stdin.write(stdin_data)
            except (OSError, ValueError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
        threading.Thread(target=feed, daemon=True).start()
    timed_out = False
    try:
        proc.wait(timeout=max(0.1, timeout))
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_group(proc)
        proc.wait()
    # Fin de lecture bornée : un petit-enfant qui garde un tube ouvert est tué avec le groupe.
    for t in readers:
        t.join(timeout=JOIN_TIMEOUT_S)
    if any(t.is_alive() for t in readers):
        _kill_group(proc)
        for t in readers:
            t.join(timeout=JOIN_TIMEOUT_S)
    return RunResult(proc.returncode, bytes(out), bytes(err), timed_out, bool(out_flags.get("truncated")))


def git(root, args, timeout=GIT_TIMEOUT_S):
    """git en lecture, sans shell, avec des options sûres ; ``None`` si git échoue."""
    try:
        res = run(["git", "-C", root] + GIT_SAFE_OPTIONS + args, root, timeout, env_overrides=GIT_ENV_OVERRIDES)
    except LaunchError as e:
        log(f"git introuvable : {e}")
        return None
    if not res.ok:
        log(f"git {' '.join(args[:2])} a échoué : {res.detail()}")
        return None
    return res.text()


_UNSAFE_ARG_RE = re.compile("[\x00-\x1f\x7f-\x9f]")


def safe_arg(value):
    """Vrai si ``value`` peut être passé à CodeGraph : pas d'option déguisée, pas de contrôle."""
    return (
        isinstance(value, str)
        and value != ""
        and not value.startswith("-")
        and not _UNSAFE_ARG_RE.search(value)
        and not _INVISIBLE_RE.search(value)
    )


# ------------------------------------------------------------------ exclusion git

def ensure_git_exclude(root):
    """Ajoute ``/.codegraph/`` à ``<git-common-dir>/info/exclude`` (une seule fois).

    Seul fichier écrit hors de ``.codegraph/``. Rend le chemin du fichier, ou ``None``
    hors d'un dépôt git. Lève ``OSError`` si le worktree est un dépôt git mais que la
    ligne n'a pas pu être écrite (l'indexation ne doit alors pas avoir lieu).
    """
    out = git(root, ["rev-parse", "--git-common-dir"])
    if out is None:
        if os.path.lexists(os.path.join(root, ".git")):
            raise OSError(f"git rev-parse --git-common-dir a échoué dans {root}")
        return None
    common = out.strip().splitlines()[0] if out.strip() else ""
    if not common:
        return None
    if not os.path.isabs(common):
        common = os.path.join(root, common)
    common = os.path.realpath(common)
    if not os.path.isdir(common):
        raise OSError(f"dossier git commun introuvable : {common}")
    info = os.path.join(common, "info")
    exclude = os.path.join(info, "exclude")
    os.makedirs(info, exist_ok=True)
    existing = ""
    if os.path.exists(exclude):
        with open(exclude, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read()
        if any(line.strip() == EXCLUDE_LINE for line in existing.splitlines()):
            return exclude
    with open(exclude, "a", encoding="utf-8") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(EXCLUDE_LINE + "\n")
    return exclude


# ------------------------------------------------------------- lecture de CodeGraph

# « - `reviewSubject` (function) (t: ReviewTarget): string — :81 »
_SYMBOL_RE = re.compile(r"^\s*- `(?P<name>[^`]+)` \((?P<kind>[A-Za-z_]+)\).*?—\s*:(?P<line>\d+)\s*$")
_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(?P<start>\d+)(?:,(?P<count>\d+))? @@")


def parse_symbols(text):
    """Symboles de ``node --symbols-only`` (Markdown) : ``[(name, kind, line)]`` triés."""
    symbols = []
    for line in text.splitlines():
        m = _SYMBOL_RE.match(line)
        if m:
            symbols.append((m.group("name"), m.group("kind"), int(m.group("line"))))
    symbols.sort(key=lambda s: (s[2], s[0]))
    return symbols


def parse_hunks(text):
    """Plages de lignes modifiées (nouvelle version) d'un ``git diff -U0``."""
    ranges = []
    for line in text.splitlines():
        m = _HUNK_RE.match(line)
        if not m:
            continue
        start = int(m.group("start"))
        count = int(m.group("count")) if m.group("count") is not None else 1
        if count == 0:
            ranges.append((max(1, start), max(1, start)))
        else:
            ranges.append((start, start + count - 1))
    return ranges


def touched_symbols(symbols, ranges):
    """Symboles rattachés aux plages modifiées ; ``ranges=None`` : tout le fichier."""
    kept = [s for s in symbols if s[1] not in SKIPPED_KINDS]
    if ranges is None:
        return kept
    picked = []
    for a, b in ranges:
        enclosing = None
        for s in kept:
            if s[2] <= a:
                enclosing = s
            elif s[2] <= b:
                if s not in picked:
                    picked.append(s)
            else:
                break
        if enclosing is not None and enclosing not in picked:
            picked.append(enclosing)
    picked.sort(key=lambda s: (s[2], s[0]))
    return picked


def _better(q1, q2):
    """Vrai si la qualité de chemin ``q1`` vaut mieux que ``q2`` (moins heuristique, plus sûre)."""
    def key(q):
        heur, conf = q
        return (0 if heur else 1, conf if conf is not None else -1.0)
    return key(q1) > key(q2)


def _combine(quality, edge):
    heur, conf = quality
    if edge.get("provenance") == "heuristic":
        heur = True
    meta = edge.get("metadata") if isinstance(edge.get("metadata"), dict) else {}
    c = meta.get("confidence")
    if isinstance(c, (int, float)) and not isinstance(c, bool):
        conf = float(c) if conf is None else min(conf, float(c))
    return (heur, conf)


def _node_info(node_id, infos):
    info = infos.get(node_id)
    if info:
        return info
    if isinstance(node_id, str) and node_id.startswith("file:"):
        path = node_id[5:]
        return {"name": os.path.basename(path), "filePath": path, "startLine": 1, "kind": "file"}
    return {"name": str(node_id), "filePath": "", "startLine": None, "kind": ""}


def impact_nodes(impact, file_path, line, max_depth):
    """Nœuds impactés d'un résultat ``impact --json`` : ``{id: (depth, quality, info)}``.

    Les profondeurs sont recalculées par un parcours en largeur depuis les racines,
    sur les arêtes ``source → target`` (l'appelant ``source`` dépend de ``target``).
    """
    defs = [d for d in impact.get("definitions") or [] if isinstance(d, dict)]
    same_file = [d for d in defs if (d.get("definition") or {}).get("filePath") == file_path]
    exact = [d for d in same_file if (d.get("definition") or {}).get("startLine") == line]
    chosen = exact or same_file
    result = {}
    for d in chosen:
        infos = {}
        definition = d.get("definition") or {}
        for n in [definition] + list(d.get("affected") or []):
            if isinstance(n, dict) and n.get("id") is not None:
                infos[n["id"]] = n
        incoming = {}
        for e in d.get("edges") or []:
            if isinstance(e, dict) and "source" in e and "target" in e:
                incoming.setdefault(e["target"], []).append(e)
        roots = [r for r in d.get("roots") or [] if r is not None] or (
            [definition["id"]] if definition.get("id") is not None else []
        )
        best = {}
        frontier = []
        for r in roots:
            if r not in best:
                best[r] = (0, (False, None))
                frontier.append(r)
        depth = 0
        while frontier and depth < max_depth:
            nxt = []
            for node in frontier:
                q = best[node][1]
                for e in incoming.get(node, ()):
                    src = e["source"]
                    cand = _combine(q, e)
                    if src not in best:
                        best[src] = (depth + 1, cand)
                        nxt.append(src)
                    elif best[src][0] == depth + 1 and _better(cand, best[src][1]):
                        best[src] = (depth + 1, cand)
            frontier = nxt
            depth += 1
        for node_id, (dep, q) in best.items():
            prev = result.get(node_id)
            if prev is None or dep < prev[0] or (dep == prev[0] and _better(q, prev[1])):
                result[node_id] = (dep, q, _node_info(node_id, infos))
    return result


# --------------------------------------------------------------------- état du plugin

class Indexer:
    """Indexation en arrière-plan d'un worktree (un thread, un sous-processus)."""

    def __init__(self, codegraph, root, subcommand):
        self.codegraph = codegraph
        self.root = root
        self.subcommand = subcommand
        self.started = time.monotonic()
        self.last_line = ""
        self.tail = ""
        self.code = None
        self.timed_out = False
        self.launch_error = None
        self.finished = False
        self.proc = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def argv(self):
        if self.subcommand == "init":
            return [self.codegraph, "init", "--yes", self.root]
        return [self.codegraph, self.subcommand, self.root]

    def start(self):
        self.thread.start()

    def _run(self):
        try:
            self.proc = subprocess.Popen(
                self.argv(),
                cwd=self.root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=_env({}),
                start_new_session=True,
                close_fds=True,
                shell=False,
            )
        except OSError as e:
            with self.lock:
                self.launch_error = str(e)
                self.finished = True
            return
        timer = threading.Timer(INDEX_TIMEOUT_S, self._timeout)
        timer.daemon = True
        timer.start()
        buf = ""
        try:
            fd = self.proc.stdout.fileno()
            while True:
                chunk = os.read(fd, 4096)
                if not chunk:
                    break
                buf = (buf + chunk.decode("utf-8", errors="replace"))[-8192:]
                line = progress_line(buf)
                if line:
                    with self.lock:
                        self.last_line = line
        except OSError:
            pass
        finally:
            try:
                self.proc.stdout.close()
            except OSError:
                pass
            code = self.proc.wait()
            timer.cancel()
            with self.lock:
                self.code = code
                self.tail = progress_line(buf[-4000:])
                self.finished = True
            log(f"indexation {self.subcommand} de {self.root} terminée : code {code}")

    def _timeout(self):
        with self.lock:
            self.timed_out = True
        if self.proc is not None:
            _kill_group(self.proc)

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            _kill_group(self.proc)

    def snapshot(self):
        with self.lock:
            return {
                "finished": self.finished,
                "code": self.code,
                "timed_out": self.timed_out,
                "launch_error": self.launch_error,
                "last_line": self.last_line,
                "tail": self.tail,
                "elapsed": int(time.monotonic() - self.started),
            }


class Plugin:
    def __init__(self):
        self.locale = "fr"
        self.config = {}
        self.permissions = []
        self.indexers = {}  # racine du worktree → Indexer
        self.cache = {}  # clé d'analyse → (instant, analyse)
        self.stop = False

    # ----------------------------------------------------------------- outils

    def t(self, locale, key, **kw):
        text = TEXTS.get(locale, TEXTS["fr"]).get(key) or TEXTS["fr"][key]
        return text.format(**kw) if kw else text

    def locale_of(self, params):
        loc = params.get("locale") if isinstance(params, dict) else None
        return loc if loc in TEXTS else self.locale

    def depth(self):
        d = self.config.get("depth", DEFAULT_DEPTH) if isinstance(self.config, dict) else DEFAULT_DEPTH
        if isinstance(d, bool) or not isinstance(d, (int, float)):
            return DEFAULT_DEPTH
        return max(1, min(5, int(d)))

    def codegraph(self):
        """Chemin de CodeGraph : ``("ok", chemin)``, ``("missing", None)`` ou ``("bad", valeur)``."""
        configured = self.config.get("codegraph") if isinstance(self.config, dict) else None
        if configured is not None:
            if (
                isinstance(configured, str)
                and os.path.isabs(configured)
                and os.path.isfile(configured)
                and os.access(configured, os.X_OK)
            ):
                return ("ok", configured)
            return ("bad", str(configured))
        found = shutil.which("codegraph")
        return ("ok", found) if found else ("missing", None)

    @staticmethod
    def has_index(root):
        return os.path.isdir(os.path.join(root, ".codegraph"))

    def doc(self, locale, blocks, refresh=False):
        doc = {"title": self.t(locale, "title"), "blocks": blocks}
        if refresh:
            doc["refresh_ms"] = REFRESH_MS
        return doc

    @staticmethod
    def notice(level, text):
        return {"type": "notice", "level": level, "text": clean(text, 2000, multiline=True)}

    def actions(self, locale, indexed, with_send):
        items = [{"id": "index", "label": self.t(locale, "update" if indexed else "index"), "primary": not with_send}]
        if with_send:
            items.append({"id": "send-impact", "label": self.t(locale, "send"), "primary": True})
        return {"type": "actions", "items": items}

    # ------------------------------------------------------------ préalables

    def context(self, locale, params):
        """Vérifie session, diff et CodeGraph ; rend ``(ctx, None)`` ou ``(None, document)``."""
        session = params.get("session") if isinstance(params.get("session"), dict) else {}
        root = session.get("worktree_root") or session.get("cwd")
        if not isinstance(root, str) or not root:
            return None, self.doc(locale, [self.notice("info", self.t(locale, "no_worktree"))])
        if not os.path.isdir(root):
            return None, self.doc(locale, [self.notice("error", self.t(locale, "worktree_gone", path=clean(root, 500)))])
        root = os.path.realpath(root)
        state, cg = self.codegraph()
        if state == "missing":
            return None, self.doc(locale, [self.notice("warning", self.t(locale, "no_codegraph"))])
        if state == "bad":
            return None, self.doc(locale, [self.notice("error", self.t(locale, "bad_codegraph", path=clean(cg, 500)))])
        diff = params.get("diff") if isinstance(params.get("diff"), dict) else None
        return {"root": root, "codegraph": cg, "diff": diff, "session": session}, None

    def index_status_blocks(self, locale, root):
        """Blocs d'état de l'indexation (en cours, échec) ; ``(blocs, en_cours)``."""
        idx = self.indexers.get(root)
        if idx is None:
            return [], False
        snap = idx.snapshot()
        if not snap["finished"]:
            text = self.t(locale, "indexing", elapsed=snap["elapsed"])
            if snap["last_line"]:
                text += "\n" + snap["last_line"]
            return [self.notice("info", text)], True
        if snap["launch_error"]:
            return [self.notice("error", self.t(locale, "launch_failed", detail=clean(snap["launch_error"], 500)))], False
        if snap["timed_out"]:
            return [self.notice("error", self.t(locale, "index_timeout", minutes=int(INDEX_TIMEOUT_S // 60)))], False
        if snap["code"] != 0:
            detail = snap["tail"] or "—"
            return [self.notice("error", self.t(locale, "index_failed", code=snap["code"], detail=detail))], False
        return [], False

    # ------------------------------------------------------------------ analyse

    def analysis_key(self, ctx):
        diff = ctx["diff"] or {}
        base = diff.get("base") if isinstance(diff.get("base"), dict) else {}
        files = tuple(
            (f.get("path"), f.get("status"), f.get("additions"), f.get("deletions"))
            for f in diff.get("files") or []
            if isinstance(f, dict)
        )
        return (ctx["root"], self.depth(), base.get("sha"), files)

    def analyse(self, ctx):
        """Symboles touchés, dépendants et tests affectés, dans le budget de rendu."""
        started = time.monotonic()
        deadline = started + RENDER_BUDGET_S
        root, cg, diff = ctx["root"], ctx["codegraph"], ctx["diff"]
        max_depth = self.depth()

        def remaining():
            return deadline - time.monotonic()

        def call_timeout(cap=CALL_TIMEOUT_S):
            # Réserve la fin d'un appel tué (lecture des tubes) dans le budget.
            return max(0.1, min(cap, remaining() - CALL_MARGIN_S))

        all_files = [f for f in diff.get("files") or [] if isinstance(f, dict) and isinstance(f.get("path"), str)]
        result = {
            "rust": any(f["path"].endswith(".rs") for f in all_files),
            "diff_truncated": bool(diff.get("truncated")),
            "files": [],
            "touched": [],
            "rows": [],
            "tests": [],
            "tests_error": None,
            "symbols_failed": 0,
            "too_many_symbols": False,
            "too_many_rows": False,
            "partial": False,
            "unsafe": 0,
            "depth": max_depth,
            "elapsed": 0,
        }
        files = [f for f in all_files if f.get("status") != "D" and not f.get("binary")]
        # Défense en profondeur : un chemin qui ressemble à une option ou porte un contrôle
        # n'est jamais passé à CodeGraph (argument `-f`, stdin d'`affected`).
        result["unsafe"] = sum(1 for f in files if not safe_arg(f["path"]))
        files = [f for f in files if safe_arg(f["path"])][:MAX_DIFF_FILES]
        result["files"] = [f["path"] for f in files]
        if not files:
            return result

        # Tests affectés : un seul appel, fait d'abord (le plus utile, le moins cher).
        try:
            res = run(
                [cg, "affected", "--stdin", "--json", "-p", root],
                root,
                call_timeout(),
                stdin_data=("\n".join(result["files"]) + "\n").encode("utf-8"),
            )
            data = json.loads(res.text()) if res.ok else None
            if isinstance(data, dict) and isinstance(data.get("affectedTests"), list):
                result["tests"] = [str(x) for x in data["affectedTests"] if isinstance(x, str)]
            else:
                result["tests_error"] = res.detail() if not res.ok else "JSON"
        except (LaunchError, ValueError) as e:
            result["tests_error"] = clean(str(e), 300)

        # Symboles touchés : `node --symbols-only` par fichier, rattachés aux lignes modifiées.
        base = diff.get("base") if isinstance(diff.get("base"), dict) else {}
        base_sha = base.get("sha") if isinstance(base.get("sha"), str) else None
        touched = []
        for f in files:
            if remaining() < 2:
                result["partial"] = True
                break
            path = f["path"]
            try:
                res = run([cg, "node", "-p", root, "-f", path, "--symbols-only"], root, call_timeout())
            except LaunchError as e:
                log(f"node {path} : {e}")
                result["symbols_failed"] += 1
                continue
            symbols = parse_symbols(res.text()) if res.ok else []
            if not symbols:
                if not res.ok:
                    result["symbols_failed"] += 1
                continue
            ranges = None
            if base_sha and f.get("status") not in ("A", "?") and re.fullmatch(r"[0-9a-fA-F]{4,64}", base_sha):
                out = git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", base_sha, "--", path],
                          timeout=call_timeout(GIT_TIMEOUT_S))
                if out is not None:
                    # Aucune plage (git ne voit pas la même chose que le démon) : tout le fichier.
                    ranges = parse_hunks(out) or None
            for name, kind, line in touched_symbols(symbols, ranges):
                if not safe_arg(name):
                    result["unsafe"] += 1
                    continue
                touched.append((path, name, kind, line))
                if len(touched) > MAX_SYMBOLS:
                    break
            if len(touched) > MAX_SYMBOLS:
                result["too_many_symbols"] = True
                touched = touched[:MAX_SYMBOLS]
                break
        result["touched"] = touched

        # Impact par symbole, profondeurs recalculées et fusionnées (profondeur minimale).
        nodes = {}
        for path, name, kind, line in touched:
            if remaining() < 1.5:
                result["partial"] = True
                break
            try:
                res = run(
                    # `--` : le nom du symbole ne peut pas être lu comme une option.
                    [cg, "impact", "-p", root, "-f", path, "--depth", str(max_depth), "--json", "--", name],
                    root,
                    call_timeout(),
                )
            except LaunchError as e:
                log(f"impact {name} : {e}")
                continue
            try:
                data = json.loads(res.text()) if res.ok else None
            except ValueError:
                data = None  # « Symbol … not found » : texte, code 0
            found = impact_nodes(data, path, line, max_depth) if isinstance(data, dict) else {}
            if not found:
                found = {f"touched:{path}:{line}:{name}": (0, (False, None), {"name": name, "filePath": path, "startLine": line, "kind": kind})}
            for node_id, (dep, q, info) in found.items():
                prev = nodes.get(node_id)
                if prev is None or dep < prev[0] or (dep == prev[0] and _better(q, prev[1])):
                    nodes[node_id] = (dep, q, info)

        # Une ligne par (symbole, fichier, ligne) : deux racines d'un même symbole ne se doublent pas.
        merged = {}
        for dep, q, info in nodes.values():
            line = info.get("startLine")
            line = line if isinstance(line, int) and not isinstance(line, bool) else None
            key = (str(info.get("name") or ""), str(info.get("filePath") or ""), line)
            prev = merged.get(key)
            if prev is None or dep < prev[0] or (dep == prev[0] and _better(q, prev[1])):
                merged[key] = (dep, q)
        rows = [
            {"name": k[0], "file": k[1], "line": k[2], "depth": dep, "heuristic": q[0], "confidence": q[1]}
            for k, (dep, q) in merged.items()
        ]
        rows.sort(key=lambda r: (r["depth"], r["file"], r["line"] if r["line"] is not None else 0, r["name"]))
        if len(rows) > MAX_ROWS:
            result["too_many_rows"] = True
            rows = rows[:MAX_ROWS]
        result["rows"] = rows
        result["elapsed"] = int(time.monotonic() - started)
        return result

    def cached_analysis(self, ctx, fresh):
        key = self.analysis_key(ctx)
        hit = self.cache.get(key)
        if not fresh and hit and time.monotonic() - hit[0] < 120:
            return hit[1]
        res = self.analyse(ctx)
        self.cache = {key: (time.monotonic(), res)}
        return res

    # ---------------------------------------------------------------- rendu

    def confidence_cell(self, locale, row):
        if row["heuristic"]:
            return self.t(locale, "heuristic")
        if row["confidence"] is not None:
            return round(row["confidence"], 2)
        return None

    @staticmethod
    def location(row):
        return f"{row['file']}:{row['line']}" if row["line"] is not None else row["file"]

    def analysis_document(self, locale, res, pre_blocks):
        blocks = list(pre_blocks)
        if res["rust"]:
            blocks.append(self.notice("warning", self.t(locale, "rust")))
        if res["diff_truncated"]:
            blocks.append(self.notice("info", self.t(locale, "diff_truncated")))
        if not res["files"]:
            blocks.append(self.notice("info", self.t(locale, "no_files")))
            blocks.append(self.actions(locale, True, False))
            return self.doc(locale, blocks)
        if res["too_many_symbols"]:
            blocks.append(self.notice("info", self.t(locale, "too_many_symbols", max=MAX_SYMBOLS)))
        if res["too_many_rows"]:
            blocks.append(self.notice("info", self.t(locale, "too_many_rows", max=MAX_ROWS)))
        if res["partial"]:
            blocks.append(self.notice("warning", self.t(locale, "budget", seconds=int(RENDER_BUDGET_S))))
        if res.get("unsafe"):
            blocks.append(self.notice("warning", self.t(locale, "unsafe", count=res["unsafe"])))
        if res["symbols_failed"]:
            blocks.append(self.notice("warning", self.t(locale, "symbols_failed", count=res["symbols_failed"])))
        if res["tests_error"]:
            blocks.append(self.notice("warning", self.t(locale, "tests_failed", detail=res["tests_error"])))
        touched_files = len({p for p, _, _, _ in res["touched"]})
        dependents = sum(1 for r in res["rows"] if r["depth"] > 0)
        blocks.append({"type": "markdown", "text": self.t(
            locale, "summary", symbols=len(res["touched"]), files=touched_files,
            dependents=dependents, depth=res["depth"], tests=len(res["tests"]))})
        table_index = None
        if res["rows"]:
            table_index = len(blocks)
            blocks.append({
                "type": "table",
                "caption": clean(self.t(locale, "table_caption"), 200),
                "columns": [
                    {"id": "symbol", "label": self.t(locale, "col_symbol")},
                    {"id": "location", "label": self.t(locale, "col_location")},
                    {"id": "depth", "label": self.t(locale, "col_depth"), "align": "end"},
                    {"id": "confidence", "label": self.t(locale, "col_confidence"), "align": "end"},
                ],
                "rows": [
                    {
                        "symbol": clean(r["name"], 2000),
                        "location": clean(self.location(r), 2000),
                        "depth": r["depth"],
                        "confidence": self.confidence_cell(locale, r),
                    }
                    for r in res["rows"]
                ],
            })
        else:
            blocks.append(self.notice("info", self.t(locale, "no_symbols")))
        tests = res["tests"][:MAX_LIST_ITEMS]
        if tests:
            blocks.append({
                "type": "list",
                "title": clean(self.t(locale, "tests_title", count=len(res["tests"])), 200),
                "ordered": False,
                "items": [{"text": clean(p, 2000)} for p in tests],
            })
        elif not res["tests_error"]:
            blocks.append({"type": "markdown", "text": self.t(locale, "no_tests")})
        blocks.append(self.actions(locale, True, True))
        doc = self.doc(locale, blocks)
        return self.fit(locale, doc, table_index)

    def fit(self, locale, doc, table_index):
        """Réduit le tableau tant que le document dépasse la taille d'une ligne du transport."""
        if table_index is None:
            return doc
        table = doc["blocks"][table_index]
        size = len(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
        if size <= MAX_DOC_BYTES:
            return doc
        rows = table["rows"]
        while rows and size > MAX_DOC_BYTES:
            rows = rows[: len(rows) // 2]
            table["rows"] = rows
            size = len(json.dumps(doc, ensure_ascii=False).encode("utf-8"))
        doc["blocks"].insert(table_index, self.notice("info", self.t(locale, "doc_too_big", rows=len(rows))))
        return doc

    def markdown(self, locale, res, ctx):
        lines = [f"# {self.t(locale, 'md_title')}", ""]
        branch = ctx["session"].get("branch")
        if isinstance(branch, str) and branch:
            lines += [self.t(locale, "md_branch", branch=clean(branch, 200).replace("`", "'")), ""]

        def code(s):
            return "`" + clean(s, 300).replace("`", "'") + "`"

        def describe(r):
            parts = [code(r["name"]), code(self.location(r))]
            if r["depth"] > 0:
                parts.append(self.t(locale, "md_depth", depth=r["depth"]))
            conf = self.confidence_cell(locale, r)
            if conf is not None:
                parts.append(self.t(locale, "md_confidence", value=conf))
            return "- " + " — ".join(parts)

        roots = [r for r in res["rows"] if r["depth"] == 0]
        deps = [r for r in res["rows"] if r["depth"] > 0]
        lines += [f"## {self.t(locale, 'md_touched')}", ""]
        lines += [describe(r) for r in roots] or [self.t(locale, "md_none")]
        lines += ["", f"## {self.t(locale, 'md_dependents', depth=res['depth'])}", ""]
        lines += [describe(r) for r in deps] or [self.t(locale, "md_none")]
        lines += ["", f"## {self.t(locale, 'md_tests')}", ""]
        lines += ["- " + code(p) for p in res["tests"]] or [self.t(locale, "md_none")]
        reasons = []
        if res["too_many_symbols"]:
            reasons.append(self.t(locale, "too_many_symbols", max=MAX_SYMBOLS))
        if res["partial"]:
            reasons.append(self.t(locale, "budget", seconds=int(RENDER_BUDGET_S)))
        if res["rust"]:
            reasons.append(self.t(locale, "rust"))
        lines += [""] + [self.t(locale, "md_partial", reason=r) for r in reasons] + ["", self.t(locale, "md_note")]
        text = "\n".join(lines) + "\n"
        if len(text) > MAX_PROPOSE_CHARS:
            note = "\n\n" + self.t(locale, "md_truncated") + "\n"
            cut = text[: MAX_PROPOSE_CHARS - len(note)]
            cut = cut[: cut.rfind("\n")] if "\n" in cut else cut
            text = cut + note
        return text

    # -------------------------------------------------------------- méthodes

    def initialize(self, params):
        if params.get("api_version") != API_VERSION:
            raise RpcError(-32602, self.t(self.locale_of(params), "bad_api", value=params.get("api_version")))
        self.locale = self.locale_of(params)
        self.config = params.get("config") if isinstance(params.get("config"), dict) else {}
        perms = params.get("permissions")
        self.permissions = [p for p in perms if isinstance(p, str)] if isinstance(perms, list) else []
        return {"api_version": API_VERSION}

    def panel_render(self, params):
        locale = self.locale_of(params)
        ctx, early = self.context(locale, params)
        if early:
            return early
        status_blocks, running = self.index_status_blocks(locale, ctx["root"])
        if running:
            return self.doc(locale, status_blocks, refresh=True)
        if ctx["diff"] is None:
            return self.doc(locale, status_blocks + [self.notice("info", self.t(locale, "no_diff"))])
        if not self.has_index(ctx["root"]):
            return self.doc(locale, status_blocks + [
                self.notice("info", self.t(locale, "no_index")),
                self.actions(locale, False, False),
            ])
        res = self.cached_analysis(ctx, fresh=True)
        return self.analysis_document(locale, res, status_blocks)

    def action_run(self, params):
        locale = self.locale_of(params)
        action = params.get("action")
        if action == "index":
            return {"document": self.action_index(locale, params)}
        if action == "send-impact":
            return self.action_send(locale, params)
        raise RpcError(-32602, self.t(locale, "unknown_action", action=clean(action, 100)))

    def action_index(self, locale, params):
        ctx, early = self.context(locale, params)
        if early:
            return early
        root = ctx["root"]
        current = self.indexers.get(root)
        if current is not None and not current.snapshot()["finished"]:
            return self.panel_render(params)
        try:
            ensure_git_exclude(root)
        except OSError as e:
            # Dépôt git dont l'exclusion n'a pas pu être écrite : pas d'index (il salirait `git status`).
            log(f"exclusion git impossible : {e}")
            return self.doc(locale, [self.notice("error", self.t(locale, "exclude_failed", detail=clean(e, 300))),
                                     self.actions(locale, self.has_index(root), False)])
        args = params.get("args") if isinstance(params.get("args"), dict) else {}
        if not self.has_index(root):
            sub = "init"
        elif args.get("full") is True:
            sub = "index"
        else:
            sub = "sync"
        idx = Indexer(ctx["codegraph"], root, sub)
        self.indexers[root] = idx
        self.cache = {}
        idx.start()
        snap = idx.snapshot()
        text = self.t(locale, "indexing", elapsed=snap["elapsed"]) + "\n" + self.t(locale, "indexing_started")
        return self.doc(locale, [self.notice("info", text)], refresh=True)

    def action_send(self, locale, params):
        ctx, early = self.context(locale, params)
        if early:
            return {"document": early}
        status_blocks, running = self.index_status_blocks(locale, ctx["root"])
        if running or ctx["diff"] is None or not self.has_index(ctx["root"]):
            return {"document": self.panel_render(params)}
        res = self.cached_analysis(ctx, fresh=False)
        result = {"propose": {"content": self.markdown(locale, res, ctx)},
                  "document": self.analysis_document(locale, res, status_blocks)}
        # Une ligne du transport fait 1 Mio au plus : le document (facultatif) cède la place.
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > MAX_DOC_BYTES:
            del result["document"]
        return result

    def shutdown(self, _params):
        self.stop = True
        return None

    def close(self):
        for idx in self.indexers.values():
            idx.stop()

    def dispatch(self, method, params):
        if method == "initialize":
            return self.initialize(params)
        if method == "panel.render":
            return self.panel_render(params)
        if method == "action.run":
            return self.action_run(params)
        if method == "shutdown":
            return self.shutdown(params)
        raise RpcError(-32601, self.t(self.locale_of(params), "unknown_method", method=clean(method, 100)))


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------- transport

def main():
    out = sys.stdout.buffer
    # Tout `print` égaré (bibliothèque, débogage) part sur stderr, jamais dans le protocole.
    sys.stdout = sys.stderr
    write_lock = threading.Lock()

    def send(obj):
        data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
        with write_lock:
            out.write(data)
            out.flush()

    plugin = Plugin()
    try:
        for raw in sys.stdin.buffer:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as e:
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": clean(f"JSON invalide : {e}", 300)}})
                continue
            if not isinstance(msg, dict) or not isinstance(msg.get("method"), str):
                if isinstance(msg, dict) and "id" in msg and "method" not in msg:
                    continue  # réponse inattendue de l'hôte : ignorée
                send({"jsonrpc": "2.0", "id": msg.get("id") if isinstance(msg, dict) else None,
                      "error": {"code": -32600, "message": "invalid request"}})
                continue
            if "id" not in msg:
                continue  # notification : rien à rendre
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            try:
                result = plugin.dispatch(msg["method"], params)
                send({"jsonrpc": "2.0", "id": msg["id"], "result": result})
            except RpcError as e:
                send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": e.code, "message": clean(e.message, 500)}})
            except Exception as e:  # noqa: BLE001 — jamais de trace sur stdout
                log(traceback.format_exc())
                send({"jsonrpc": "2.0", "id": msg["id"], "error": {
                    "code": -32603, "message": plugin.t(plugin.locale_of(params), "internal", detail=clean(e, 300))}})
            if plugin.stop:
                break
    finally:
        plugin.close()


if __name__ == "__main__":
    main()
