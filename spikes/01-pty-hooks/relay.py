#!/usr/bin/env python3
"""Relais de hook : journalise l'événement, et pour PermissionRequest attend une décision.

Usage : relay.py <Événement> [délai_du_hook_en_s]
Ne doit jamais faire planter claude : toute erreur est journalisée puis on sort en 0, sans sortie.
"""
import json
import os
import secrets
import signal
import sys
import time

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SPIKE_DIR, "out")
EVENTS = os.path.join(OUT, "events.jsonl")


class Killed(Exception):
    """claude a tué le hook (délai dépassé ou session fermée)."""


def on_signal(signum, _frame):
    raise Killed(signal.Signals(signum).name)


def log(event, **fields):
    os.makedirs(OUT, exist_ok=True)
    line = json.dumps({"ts": time.time(), "event": event, **fields}, ensure_ascii=False) + "\n"
    # Un seul write() en O_APPEND : les hooks tournent en parallèle, les lignes ne doivent pas se mélanger.
    fd = os.open(EVENTS, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


def token_fields():
    token = os.environ.get("ORCH_TOKEN")
    try:
        with open(os.path.join(OUT, "expected_token"), encoding="utf-8") as f:
            expected = f.read().strip()
    except OSError:
        expected = None
    return {"orch_token_present": bool(token), "orch_token_matches": bool(token) and token == expected}


def wait_decision(payload, hook_timeout):
    # PermissionRequest ne reçoit pas de tool_use_id (doc) : on retombe presque toujours sur ts+aléa.
    req_id = payload.get("tool_use_id") or f"{int(time.time() * 1000)}-{secrets.token_hex(3)}"
    pending_dir = os.path.join(OUT, "pending")
    decision_path = os.path.join(OUT, "decisions", f"{req_id}.json")
    pending_path = os.path.join(pending_dir, f"{req_id}.json")
    os.makedirs(pending_dir, exist_ok=True)
    os.makedirs(os.path.dirname(decision_path), exist_ok=True)
    with open(pending_path, "w", encoding="utf-8") as f:
        json.dump({"id": req_id, "since": time.time(), "payload": payload}, f, ensure_ascii=False)
    print(f"[spike] permission en attente : {req_id} ({payload.get('tool_name')})", file=sys.stderr)

    start = time.time()
    # SPIKE_RELAY_GRACE négatif : le relais attend plus longtemps que claude, pour voir claude le tuer.
    deadline = start + max(1, hook_timeout - float(os.environ.get("SPIKE_RELAY_GRACE", "5")))
    outcome = "deadline"
    try:
        while time.time() < deadline:
            if os.path.exists(decision_path):
                with open(decision_path, encoding="utf-8") as f:
                    raw = f.read().strip()
                try:
                    outcome = json.loads(raw).get("decision", "")
                except ValueError:
                    outcome = raw
                os.remove(decision_path)
                break
            time.sleep(0.2)
    except Killed as exc:
        outcome = f"killed:{exc}"
    finally:
        try:
            os.remove(pending_path)
        except OSError:
            pass
    log("relay.decision", id=req_id, outcome=outcome, waited_s=round(time.time() - start, 2))

    if outcome in ("allow", "deny"):
        decision = {"behavior": outcome}
        if outcome == "deny":
            decision["message"] = "Refusé depuis decide.py (prototype n° 1)"
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}))
    # « terminal » ou délai dépassé : aucune sortie, la TUI doit afficher sa propre demande.


def main():
    # claude tue le hook au bout du délai : on veut que les finally s'exécutent (fichier pending).
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)
    event = sys.argv[1] if len(sys.argv) > 1 else "unknown"
    hook_timeout = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("SPIKE_HOOK_TIMEOUT", "600"))
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except ValueError:
        payload = {"_raw": raw}
    log(event, **token_fields(), payload=payload)
    if event == "PermissionRequest":
        wait_decision(payload, hook_timeout)


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 — on ne casse jamais claude
        try:
            log("relay.error", error=repr(exc), argv=sys.argv[1:])
        except BaseException:
            pass
    sys.exit(0)
