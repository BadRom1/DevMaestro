#!/usr/bin/env python3
"""Anonymise un .jsonl de NOS sessions de test pour en faire une fixture.

Usage : anonymize.py <entrée.jsonl> <sortie.jsonl>

- chemins et identité : /home/<user> → ~, nom d'utilisateur, courriel, machine ;
- pièces jointes de contexte (CLAUDE.md, compétences, MCP, compte, environnement…) : valeurs retirées,
  clés gardées ;
- hors du fil (`message`, `toolUseResult`, `payload` des hooks) : toute chaîne de plus de 120 caractères est remplacée par
  sa longueur (requêtes d'API, instantanés, rendus) ;
- résumé de compaction (entrée et `last_assistant_message` des agents internes) et contenu des
  fichiers joints : remplacés (ils reprennent les consignes et fichiers de l'utilisateur) ;
- chemins sous ~/.claude hors de `projects/` (hooks, consignes de l'utilisateur) : remplacés.
"""
import getpass
import json
import os
import re
import socket
import sys

HOME = os.path.expanduser("~")
USER = getpass.getuser()
SENSITIVE_ATTACHMENTS = {"session_context", "credential_org", "environment", "instructions", "skill_listing",
                         "deferred_tools_delta", "deferred_tools_record", "mcp_instructions_delta",
                         "agent_listing_delta", "prompt_snapshot", "advisor_tool", "remote_session_change",
                         "nested_memory", "output_style", "output_style_instructions", "language", "model", "date"}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}")


UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
# Scratchpad de la session Claude Code qui a mené le prototype (chemin brut et forme encodée).
SCRATCH = re.compile(r"/tmp/claude-\d+/[^/\s\"]+/" + UUID + r"/scratchpad")
SCRATCH_ENC = re.compile(r"-tmp-claude-\d+-[A-Za-z0-9-]*?-" + UUID + r"-scratchpad")


# Fichiers de configuration de l'utilisateur (hooks, mémoire, consignes) : seul `projects/` est gardé.
USER_CONFIG = re.compile(r"~/\.claude/(?!projects/)[^\s\"'`]*")


def scrub_str(s):
    s = SCRATCH.sub("/tmp/scratchpad", s)
    s = SCRATCH_ENC.sub("-tmp-scratchpad", s)
    s = s.replace(HOME, "~").replace("-home-" + USER + "-", "-home-user-")
    s = USER_CONFIG.sub("~/.claude/<retiré>", s)
    s = re.sub(r"~/(?!\.claude)[^/\s\"'`]+/[^\s\"'`]*", "~/<projet>", s)
    s = re.sub(r"/tmp/claude-\d+/", "/tmp/claude-N/", s)
    s = re.sub(r"\$\{[A-Z_]+\}|\$[A-Z_]{3,}", "$<var>", s)
    s = re.sub(r"\brtk (?=[a-z])", "", s)  # réécriture de commande par un hook de l'utilisateur
    s = s.replace(socket.gethostname(), "machine")
    s = EMAIL.sub("user@example.com", s)
    s = re.sub(re.escape(USER), "user", s, flags=re.I)
    # Mots en plus à masquer (nom de famille…), passés par l'environnement : rien de personnel dans le dépôt.
    for word in filter(None, os.environ.get("ANONYMIZE_EXTRA", "").split(",")):
        s = re.sub(re.escape(word.strip()), "x", s, flags=re.I)
    return s


def blank(v):
    """Valeur retirée de même forme : un parseur testé sur la fixture voit les vrais types."""
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return 0
    if isinstance(v, list):
        return []
    if isinstance(v, dict):
        return {}
    return "<retiré>"


def scrub(v, cut_long):
    if isinstance(v, str):
        if cut_long and len(v) > 120:
            return f"<retiré : {len(v)} caractères>"
        return scrub_str(v)
    if isinstance(v, list):
        return [scrub(x, cut_long) for x in v]
    if isinstance(v, dict):
        return {scrub_str(k): scrub(x, cut_long) for k, x in v.items()}
    return v


def anonymize(e):
    if not isinstance(e, dict):
        return e
    a = e.get("attachment")
    if isinstance(a, dict) and a.get("type") in SENSITIVE_ATTACHMENTS:
        e["attachment"] = {"type": a["type"], **{k: blank(v) for k, v in a.items() if k != "type"}}
    if isinstance(a, dict) and a.get("type") in ("file", "compact_file_reference", "edited_text_file"):
        e["attachment"] = {k: ("<retiré>" if k in ("content", "snippet") else v) for k, v in a.items()}
    # Hooks de l'utilisateur (commandes de ses hooks Stop) et définitions d'outils (MCP, connecteurs).
    for h in e.get("hookInfos") or []:
        if isinstance(h, dict) and "command" in h:
            h["command"] = "<hook de l'utilisateur>"
    if str(e.get("type", "")).startswith("api-request") and "k" not in e:  # pas les lignes du suiveur
        e = {k: (v if k in ("type", "sessionId", "timestamp", "version", "agentId", "id", "hash", "shapeHash")
                 else blank(v)) for k, v in e.items()}
    p = e.get("payload")
    if isinstance(p, dict) and p.get("last_assistant_message") and not p.get("agent_type"):
        p["last_assistant_message"] = "<retiré : agent interne (compaction, suggestion…)>"
    if e.get("isCompactSummary") and isinstance(e.get("message"), dict):
        e["message"]["content"] = "<résumé de compaction retiré>"
    out = {}
    for k, v in e.items():
        keep_content = (k in ("message", "toolUseResult") and e.get("type") in ("user", "assistant")) \
            or k in ("payload", "file", "dir")
        out[scrub_str(k)] = scrub(v, cut_long=not keep_content)
    return out


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8") as f, open(dst, "w", encoding="utf-8") as g:
        for raw in f:
            if not raw.strip():
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                g.write(scrub_str(raw))
                continue
            g.write(json.dumps(anonymize(e), ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
