#!/usr/bin/env python3
"""Rendu HTML statique d'un transcript Claude Code, pour juger de la fidélité de la voie A.

Usage : render.py <transcript.jsonl> <sortie.html>
        render.py --stats <transcript.jsonl>...   (n'écrit rien : temps de rendu et replis, sans contenu)

Les sous-agents (`<session>/subagents/agent-<id>.jsonl`) sont rendus sous l'appel `Agent` qui les a
lancés. Tout type d'entrée inconnu passe par un rendu de repli (type, clés, JSON replié) : un format
qui évolue ne casse pas l'affichage. Le HTML produit contient la conversation : il reste dans le
scratchpad, jamais dans le dépôt.
"""
import html
import json
import os
import re
import sys
from collections import Counter

# Entrées de service : utiles au démon (titre, mode, coût), pas au fil de la conversation.
PLUMBING = {"api-request", "api-request-blob", "api-request-shape", "last-prompt", "mode", "permission-mode",
            "atis-latch", "file-history-snapshot", "file-history-delta", "cost-state", "queue-operation",
            "custom-title", "agent-name", "frame-link", "pr-link", "relocated", "bridge-session", "worktree-state",
            "started", "result", "continued-in", "artifact-autoreact-ledger", "artifact-comment-monitor"}
# Pièces jointes montrées (en ligne discrète) ; les autres sont du contexte injecté pour le modèle.
SHOWN_ATTACHMENTS = {"file", "edited_text_file", "queued_command", "hook_blocking_error", "hook_cancelled",
                     "plan_mode_exit", "auto_mode_exit", "compact_file_reference", "image"}
# Contexte injecté pour le modèle, connu et volontairement masqué.
CONTEXT_ATTACHMENTS = {"hook_success", "total_tokens_reminder", "output_style", "prompt_snapshot", "deferred_tools_record",
                       "deferred_tools_delta", "skill_listing", "environment", "mcp_instructions_delta", "date",
                       "session_context", "model", "instructions", "advisor_tool", "credential_org",
                       "remote_session_change", "agent_listing_delta", "auto_mode", "silent_turn_reminder", "language",
                       "output_style_instructions", "hook_additional_context", "diagnostics", "command_permissions",
                       "task_reminder", "nested_memory", "dynamic_skill", "hook_permission_decision", "task_status",
                       "invoked_skills", "read_truncation_notice", "team_context", "at_mention_reference",
                       "skill_mention", "session_cron_carry", "date_change", "structured_output"}
SYSTEM_SHOWN = {"compact_boundary", "local_command", "api_error", "informational", "away_summary", "turn_duration",
                "agents_killed"}

CSS = """
:root{--bg:#faf9f7;--fg:#1f1e1c;--muted:#6b6862;--card:#fff;--line:#e4e1db;--user:#efe9df;--accent:#b4532a;--code:#f3f1ed}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--fg:#ece9e3;--muted:#a19d95;--card:#262522;--line:#3a3833;--user:#2f2c27;--accent:#e08a5c;--code:#2c2a27}}
body{background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif;margin:0}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin-bottom:24px}
.msg{margin:14px 0}.user{background:var(--user);border-radius:12px;padding:10px 14px;white-space:pre-wrap;margin-left:15%}
.text{white-space:pre-wrap}.meta{color:var(--muted);font-size:12.5px;margin:6px 0}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:6px 10px}
summary{cursor:pointer;font-size:13.5px}summary b{color:var(--accent);font-weight:600}
pre{background:var(--code);padding:8px;border-radius:6px;overflow:auto;font-size:12.5px;max-height:420px;white-space:pre-wrap;word-break:break-word}
.sep{border-top:1px dashed var(--line);margin:22px 0;text-align:center;color:var(--muted);font-size:12px}
.sep span{background:var(--bg);position:relative;top:-10px;padding:0 8px}
.sub-agent{border-left:3px solid var(--accent);padding-left:10px;margin:8px 0 8px 6px}
.q{border:1px solid var(--accent);border-radius:8px;padding:8px 12px;margin:6px 0}.err{color:#c0392b}
.unknown summary{color:var(--muted)}code{background:var(--code);padding:0 3px;border-radius:3px}
.add{color:#2e7d32}.del{color:#c62828}
"""


def esc(s):
    return html.escape(str(s))


def inline_md(s):
    """Markdown minimal : échappement, `code`, **gras**. Le vrai rendu Markdown est l'affaire du front."""
    s = esc(s)
    s = re.sub(r"`([^`\n]+)`", r"<code>\1</code>", s)
    return re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", s)


def jdump(v, limit=6000):
    s = json.dumps(v, ensure_ascii=False, indent=1)
    return s if len(s) <= limit else s[:limit] + f"\n… ({len(s) - limit} caractères de plus)"


def load(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            try:
                e = json.loads(raw)
            except ValueError:
                out.append({"type": "<json invalide>", "_line": n})
                continue
            out.append(e if isinstance(e, dict) else {"type": "<non-objet>", "_line": n})
    return out


def tool_summary(name, inp):
    if not isinstance(inp, dict):
        return ""
    for key in ("file_path", "command", "pattern", "description", "query", "url", "skill"):
        if key in inp:
            return str(inp[key])[:140]
    return ""


def result_text(block):
    c = block.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", f"[{b.get('type')}]") for b in c if isinstance(b, dict))
    return ""


class Renderer:
    def __init__(self, path):
        self.path = path
        self.entries = load(path)
        self.sub_dir = os.path.join(os.path.splitext(path)[0], "subagents")
        self.results = {}  # tool_use_id -> (bloc tool_result, toolUseResult)
        for e in self.entries:
            if e.get("type") == "user":
                for b in self.blocks(e):
                    if b.get("type") == "tool_result":
                        self.results[b.get("tool_use_id")] = (b, e.get("toolUseResult"))
        self.counts = Counter()

    @staticmethod
    def blocks(e):
        c = (e.get("message") or {}).get("content")
        return [b for b in c if isinstance(b, dict)] if isinstance(c, list) else []

    def unknown(self, e, why):
        self.counts["repli"] += 1
        label = e.get("type", "?") + (f"/{e['subtype']}" if e.get("subtype") else "")
        self.counts[f"repli:{label}"] += 1
        return (f'<details class="unknown"><summary>{esc(why)} : <code>{esc(label)}</code> '
                f'({esc(", ".join(sorted(e.keys()))[:200])})</summary><pre>{esc(jdump(e, 3000))}</pre></details>')

    def user_text(self, e, txt):
        m = re.match(r"\s*<([a-z0-9_-]+)", txt)
        tag = m.group(1) if m else None
        if e.get("isCompactSummary"):
            return f'<details><summary><b>Résumé de compaction</b></summary><div class="text">{esc(txt)}</div></details>'
        if e.get("isMeta"):
            return f'<div class="meta">Contexte injecté ({esc(tag or "texte")}), masqué</div>'
        if tag == "task-notification":
            summ = re.search(r"<summary>(.*?)</summary>", txt, re.S)
            res = re.search(r"<result>(.*?)</result>", txt, re.S)
            return (f'<details><summary><b>Notification de sous-agent</b> {esc(summ.group(1) if summ else "")}'
                    f'</summary><div class="text">{esc(res.group(1) if res else txt)}</div></details>')
        if tag in ("command-name", "command-message"):
            name = re.search(r"<command-name>(.*?)</command-name>", txt)
            args = re.search(r"<command-args>(.*?)</command-args>", txt, re.S)
            return f'<div class="meta">Commande <code>{esc(name.group(1) if name else txt[:60])}</code> {esc(args.group(1) if args else "")}</div>'
        if tag in ("local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr", "bash-input"):
            inner = re.sub(r"\x1b\[[0-9;]*m", "", re.sub(r"</?[a-z-]+>", "", txt))  # la sortie garde ses codes ANSI
            return f'<div class="meta">{esc(tag)}</div><pre>{esc(inner)}</pre>' if inner.strip() else ""
        # Collage long : la TUI montre « [Pasted text #1 +N lines] », le transcript a le contenu complet.
        def paste(mm):
            return f'</div><details><summary>Texte collé ({mm.group(2).count(chr(10))} lignes)</summary><pre>{esc(mm.group(2))}</pre></details><div class="user">'
        if "<pasted_content" in txt:
            parts = re.split(r'(<pasted_content id="[^"]*">\n?.*?</pasted_content[^>]*>)', txt, flags=re.S)
            out = ""
            for p in parts:
                mm = re.match(r'<pasted_content id="([^"]*)">\n?(.*?)</pasted_content[^>]*>', p, re.S)
                out += paste(mm) if mm else esc(p)
            return f'<div class="msg user">{out}</div>'
        return f'<div class="msg user">{esc(txt)}</div>'

    def tool(self, b, depth):
        name, inp = b.get("name"), b.get("input")
        res, tur = self.results.get(b.get("id"), (None, None))
        status = "" if res else ' <span class="meta">(sans résultat)</span>'
        if res and res.get("is_error"):
            status = ' <span class="err">(erreur)</span>'
        body = ""
        if name == "AskUserQuestion" and isinstance(inp, dict):
            for q in inp.get("questions", []):
                opts = ", ".join(o.get("label", "") for o in q.get("options", []))
                body += f'<div class="q"><b>{esc(q.get("question", ""))}</b><div class="meta">{esc(opts)}</div></div>'
            if isinstance(tur, dict) and tur.get("answers"):
                body += f'<div class="meta">Réponse : {esc(json.dumps(tur["answers"], ensure_ascii=False))}</div>'
            return f'<div class="msg">{body}</div>'
        body += f"<pre>{esc(jdump(inp))}</pre>"
        if isinstance(tur, dict) and tur.get("structuredPatch"):
            lines = []
            for h in tur["structuredPatch"]:
                for l in h.get("lines", []):
                    cls = "add" if l.startswith("+") else "del" if l.startswith("-") else ""
                    lines.append(f'<span class="{cls}">{esc(l)}</span>')
            body += "<pre>" + "\n".join(lines) + "</pre>"
        elif res:
            body += f"<pre>{esc(result_text(res)[:4000])}</pre>"
        sub = ""
        if name in ("Agent", "Task"):
            agent_id = tur.get("agentId") if isinstance(tur, dict) else None
            sub = self.subagent(agent_id, b.get("id"), depth)
        return (f'<details><summary><b>{esc(name)}</b> {esc(tool_summary(name, inp))}{status}</summary>{body}</details>'
                + sub)

    def subagent(self, agent_id, tool_use_id, depth):
        path = None
        if agent_id:
            path = os.path.join(self.sub_dir, f"agent-{agent_id}.jsonl")
        elif os.path.isdir(self.sub_dir):  # repli : le .meta.json porte toolUseId
            for n in os.listdir(self.sub_dir):
                if n.endswith(".meta.json"):
                    try:
                        if json.load(open(os.path.join(self.sub_dir, n))).get("toolUseId") == tool_use_id:
                            path = os.path.join(self.sub_dir, n[:-10] + ".jsonl")
                    except (OSError, ValueError):
                        pass
        if not path or not os.path.exists(path) or depth > 2:
            return '<div class="meta">Transcript du sous-agent introuvable</div>' if agent_id else ""
        r = Renderer(path)
        r.sub_dir = self.sub_dir
        inner = r.body(depth + 1)
        self.counts.update({k: v for k, v in r.counts.items() if k.startswith("repli")})
        return f'<div class="sub-agent"><div class="meta">Sous-agent {esc(agent_id)}</div>{inner}</div>'

    def body(self, depth=0):
        out, last_msg = [], None
        for e in self.entries:
            t = e.get("type")
            self.counts[t] += 1
            if t in PLUMBING:
                continue
            if t == "user":
                c = (e.get("message") or {}).get("content")
                if isinstance(c, str):
                    out.append(self.user_text(e, c))
                    continue
                for b in self.blocks(e):
                    if b.get("type") == "text":
                        out.append(self.user_text(e, b.get("text", "")))
                    elif b.get("type") == "image":
                        out.append('<div class="meta">Image collée</div>')
                    elif b.get("type") != "tool_result":
                        out.append(self.unknown(b, "Bloc utilisateur inconnu"))
                if depth == 0 and not self.blocks(e) and not isinstance(c, str):
                    out.append(self.unknown(e, "Message utilisateur sans contenu lisible"))
            elif t == "assistant":
                msg = e.get("message") or {}
                if msg.get("id") != last_msg:
                    last_msg = msg.get("id")
                for b in self.blocks(e):
                    bt = b.get("type")
                    if bt == "text":
                        out.append(f'<div class="msg text">{inline_md(b.get("text", ""))}</div>')
                    elif bt == "thinking":
                        th = b.get("thinking") or ""
                        out.append(f'<details><summary>Réflexion</summary><div class="text">{esc(th)}</div></details>'
                                   if th else '<div class="meta">Réflexion (contenu non conservé)</div>')
                    elif bt == "redacted_thinking":
                        out.append('<div class="meta">Réflexion masquée</div>')
                    elif bt == "tool_use":
                        out.append(self.tool(b, depth))
                    elif bt in ("server_tool_use", "advisor_tool_result", "tool_search_tool_result",
                                "web_search_tool_result"):
                        out.append(f'<details><summary>{esc(bt)} {esc(b.get("name", ""))}</summary><pre>{esc(jdump(b, 2000))}</pre></details>')
                    else:
                        out.append(self.unknown(b, "Bloc assistant inconnu"))
            elif t == "system":
                st = e.get("subtype")
                if st == "compact_boundary":
                    out.append('<div class="sep"><span>Conversation compactée</span></div>')
                elif st == "turn_duration":
                    out.append(f'<div class="meta">Tour terminé en {e.get("durationMs", 0) / 1000:.1f} s</div>')
                elif st in SYSTEM_SHOWN:
                    content = e.get("content") or ""
                    out.append(f'<div class="meta">{esc(st)} : {esc(re.sub(r"</?[a-z-]+>", "", str(content))[:500])}</div>')
                elif st in ("stop_hook_summary",):
                    continue
                else:
                    out.append(self.unknown(e, "Entrée système inconnue"))
            elif t == "attachment":
                a = e.get("attachment") or {}
                if a.get("type") not in SHOWN_ATTACHMENTS | CONTEXT_ATTACHMENTS:
                    # Pièce jointe inconnue : comptée comme repli, montrée repliée.
                    out.append(self.unknown({"type": f"attachment/{a.get('type')}", **{k: v for k, v in e.items() if k != "type"}},
                                            "Pièce jointe inconnue"))
                elif a.get("type") in SHOWN_ATTACHMENTS:
                    label = a.get("filename") or a.get("path") or a.get("command") or ""
                    out.append(f'<div class="meta">Pièce jointe {esc(a.get("type"))} {esc(str(label)[:120])}</div>')
            elif t in ("ai-title", "summary"):
                continue
            else:
                out.append(self.unknown(e, "Type d'entrée inconnu"))
        return "\n".join(x for x in out if x)

    def page(self):
        title = next((e.get("aiTitle") or e.get("title") for e in reversed(self.entries) if e.get("type") == "ai-title"),
                     None) or os.path.basename(self.path)
        versions = sorted({e.get("version") for e in self.entries if e.get("version")})
        body = self.body()
        stats = ", ".join(f"{k} {v}" for k, v in self.counts.most_common(8))
        return (f'<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" '
                f'content="width=device-width,initial-scale=1"><title>{esc(title)}</title><style>{CSS}</style></head>'
                f'<body><main><h1>{esc(title)}</h1><div class="sub">{len(self.entries)} entrées · versions '
                f'{esc(", ".join(versions))} · {esc(stats)}</div>{body}</main></body></html>')


def stats_only(paths):
    total, fallbacks, worst = 0.0, Counter(), (0, "")
    for p in paths:
        t0 = time.perf_counter()
        r = Renderer(p)
        r.page()
        dt = time.perf_counter() - t0
        total += dt
        worst = max(worst, (dt, f"{os.path.getsize(p)} octets, {len(r.entries)} entrées"))
        fallbacks.update({k: v for k, v in r.counts.items() if k.startswith("repli:")})
    print(json.dumps({"files": len(paths), "render_total_s": round(total, 2), "slowest": [round(worst[0], 3), worst[1]],
                      "fallbacks": dict(fallbacks.most_common())}, ensure_ascii=False))


if __name__ == "__main__":
    import time
    if sys.argv[1] == "--stats":
        stats_only(sys.argv[2:])
        sys.exit(0)
    t0 = time.perf_counter()
    r = Renderer(sys.argv[1])
    page = r.page()
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(page)
    print(json.dumps({"entries": len(r.entries), "html_bytes": len(page), "fallbacks": r.counts.get("repli", 0),
                      "seconds": round(time.perf_counter() - t0, 3)}))
