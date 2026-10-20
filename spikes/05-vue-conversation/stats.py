#!/usr/bin/env python3
"""Statistiques en lecture seule sur des transcripts Claude Code (Q7, Q8 du prototype n° 5).

Usage : stats.py <sortie.json> <dossier projects ou fichier .jsonl> [...]

Sert aussi d'inventaire (Q2) sur les transcripts de nos sessions de test.

Ne lit que des noms de champs, des types et des tailles : aucun contenu de conversation
n'est recopié. La sortie va dans le scratchpad, jamais dans le dépôt.
"""
import json
import os
import re
import statistics
import sys
import time
from collections import Counter, defaultdict


def kind_of_entry(e):
    t = e.get("type", "<sans type>")
    if t == "system" and e.get("subtype"):
        return f"system/{e['subtype']}"
    if t == "attachment" and isinstance(e.get("attachment"), dict):
        return f"attachment/{e['attachment'].get('type', '?')}"
    return str(t)


def blocks_of(e):
    msg = e.get("message")
    if isinstance(msg, dict):
        c = msg.get("content")
        if isinstance(c, list):
            return [b for b in c if isinstance(b, dict)]
    return []


def version_key(v):
    try:
        return tuple(int(x) for x in v.split("."))
    except Exception:  # noqa: BLE001
        return (999,)


def main():
    out_path, roots = sys.argv[1], sys.argv[2:]
    files = [r for r in roots if r.endswith(".jsonl")]
    for root in [r for r in roots if not r.endswith(".jsonl")]:
        for dirpath, _dirs, names in os.walk(root):
            for n in names:
                if n.endswith(".jsonl"):
                    files.append(os.path.join(dirpath, n))

    per_file = []
    entry_kinds = Counter()
    block_kinds = Counter()
    entry_keys = defaultdict(Counter)  # type d'entrée -> clés de premier niveau
    message_keys = defaultdict(Counter)
    block_keys = defaultdict(Counter)
    versions_files = Counter()
    versions_lines = Counter()
    kinds_by_version = defaultdict(set)
    keys_by_version = defaultdict(set)  # (version) -> {"user.<clé>", ...}
    invalid_lines = 0
    content_shapes = Counter()  # user: content str vs list
    user_tags = Counter()  # balise de tête des prompts (nom seulement, pas le contenu)
    tool_result_keys = defaultdict(Counter)  # nom d'outil -> clés de toolUseResult
    tool_names = {}
    user_flags = Counter()
    t_total = 0.0

    for path in files:
        is_sub = "/subagents/" in path
        size = os.path.getsize(path)
        lines = 0
        max_line = 0
        file_versions = set()
        t0 = time.perf_counter()
        with open(path, "rb") as f:
            for raw in f:
                lines += 1
                max_line = max(max_line, len(raw))
                try:
                    e = json.loads(raw)
                except ValueError:
                    invalid_lines += 1
                    continue
                if not isinstance(e, dict):
                    invalid_lines += 1
                    continue
                k = kind_of_entry(e)
                entry_kinds[k] += 1
                base = e.get("type", "<sans type>")
                for key in e:
                    entry_keys[base][key] += 1
                v = e.get("version")
                if isinstance(v, str):
                    file_versions.add(v)
                    versions_lines[v] += 1
                    kinds_by_version[v].add(k)
                    for key in e:
                        keys_by_version[v].add(f"{base}.{key}")
                msg = e.get("message")
                if isinstance(msg, dict):
                    for key in msg:
                        message_keys[base][key] += 1
                    c = msg.get("content")
                    content_shapes[f"{base}:{type(c).__name__}"] += 1
                if base == "user" and isinstance(msg, dict):
                    c = msg.get("content")
                    txt = c if isinstance(c, str) else next((b.get("text", "") for b in blocks_of(e)
                                                             if b.get("type") == "text"), None)
                    if txt is not None:
                        m = re.match(r"\s*<([a-z0-9_-]+)", txt)
                        user_tags[(m.group(1) if m else "texte libre") + (" (isMeta)" if e.get("isMeta") else "")] += 1
                    for flag in ("isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "promptSource", "origin"):
                        if flag in e:
                            user_flags[f"{flag}={json.dumps(e[flag], ensure_ascii=False)[:60]}"] += 1
                    tur = e.get("toolUseResult")
                    for b in blocks_of(e):
                        if b.get("type") == "tool_result" and isinstance(tur, dict):
                            name = tool_names.get(b.get("tool_use_id"), "?")
                            for key in tur:
                                tool_result_keys[name][key] += 1
                for b in blocks_of(e):
                    if b.get("type") == "tool_use":
                        tool_names[b.get("id")] = b.get("name")
                    bt = b.get("type", "<sans type>")
                    block_kinds[f"{base}/{bt}"] += 1
                    for key in b:
                        block_keys[bt][key] += 1
                    if isinstance(v, str):
                        kinds_by_version[v].add(f"bloc:{bt}")
        t_total += time.perf_counter() - t0
        for v in file_versions:
            versions_files[v] += 1
        per_file.append({"subagent": is_sub, "size": size, "lines": lines, "max_line": max_line,
                         "versions": sorted(file_versions, key=version_key),
                         "parse_s": round(time.perf_counter() - t0, 4)})

    def dist(vals):
        if not vals:
            return {}
        vals = sorted(vals)
        return {"n": len(vals), "median": statistics.median(vals), "p90": vals[int(len(vals) * 0.9) - 1 if len(vals) > 1 else 0],
                "max": vals[-1], "sum": sum(vals)}

    main_files = [p for p in per_file if not p["subagent"]]
    sub_files = [p for p in per_file if p["subagent"]]
    biggest = max(per_file, key=lambda p: p["size"]) if per_file else None
    ordered_versions = sorted(versions_files, key=version_key)
    # Q8 : ce qui apparaît ou disparaît d'une version à l'autre (types et clés).
    evolution = []
    prev_kinds, prev_keys = set(), set()
    for v in ordered_versions:
        evolution.append({"version": v, "files": versions_files[v], "lines": versions_lines[v],
                          "new_kinds": sorted(kinds_by_version[v] - prev_kinds),
                          "new_keys": sorted(keys_by_version[v] - prev_keys)})
        prev_kinds |= kinds_by_version[v]
        prev_keys |= keys_by_version[v]

    result = {
        "roots": roots,
        "files": {"main": len(main_files), "subagents": len(sub_files)},
        "size_main": dist([p["size"] for p in main_files]),
        "size_subagents": dist([p["size"] for p in sub_files]),
        "lines_main": dist([p["lines"] for p in main_files]),
        "max_line_bytes": max((p["max_line"] for p in per_file), default=0),
        "biggest": biggest,
        "parse_total_s": round(t_total, 2),
        "invalid_lines": invalid_lines,
        "versions": {v: {"files": versions_files[v], "lines": versions_lines[v]} for v in ordered_versions},
        "entry_kinds": dict(entry_kinds.most_common()),
        "block_kinds": dict(block_kinds.most_common()),
        "content_shapes": dict(content_shapes),
        "user_tags": dict(user_tags.most_common()),
        "user_flags": dict(user_flags.most_common()),
        "tool_result_keys": {k: dict(c.most_common()) for k, c in tool_result_keys.items()},
        "entry_keys": {k: dict(c.most_common()) for k, c in entry_keys.items()},
        "message_keys": {k: dict(c.most_common()) for k, c in message_keys.items()},
        "block_keys": {k: dict(c.most_common()) for k, c in block_keys.items()},
        "evolution": evolution,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(json.dumps({k: result[k] for k in ("files", "size_main", "size_subagents", "lines_main", "max_line_bytes",
                                             "biggest", "parse_total_s", "invalid_lines")}, indent=1))


if __name__ == "__main__":
    main()
