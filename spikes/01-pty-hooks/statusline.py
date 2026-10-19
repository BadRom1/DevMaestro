#!/usr/bin/env python3
"""Statusline relais : journalise le JSON reçu, puis exécute la statusline de l'utilisateur."""
import json
import os
import subprocess
import sys
import time

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def user_command():
    cmd = os.environ.get("SPIKE_USER_STATUSLINE")
    if cmd:
        return cmd
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    try:
        with open(os.path.join(config_dir, "settings.json"), encoding="utf-8") as f:
            return (json.load(f).get("statusLine") or {}).get("command")
    except (OSError, ValueError, AttributeError):
        return None


def fallback(data):
    pct = (data.get("context_window") or {}).get("used_percentage")
    cost = (data.get("cost") or {}).get("total_cost_usd")
    pct_s = f"{pct:.0f} %" if isinstance(pct, (int, float)) else "?"
    cost_s = f"{cost:.2f} $".replace(".", ",") if isinstance(cost, (int, float)) else "?"
    return f"[spike] ctx {pct_s} · {cost_s}"


def main():
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {"_raw": raw}
    try:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, "statusline.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": time.time(), "payload": data}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    cmd = user_command()
    if cmd:
        try:
            res = subprocess.run(["bash", "-c", cmd], input=raw, capture_output=True, text=True, timeout=2)
            if res.stdout.strip():
                print(res.stdout, end="")
                return
        except (OSError, subprocess.SubprocessError):
            pass
    print(fallback(data) if isinstance(data, dict) else "[spike]")


if __name__ == "__main__":
    try:
        main()
    except BaseException:  # noqa: BLE001 — jamais d'erreur visible dans la TUI
        print("[spike] statusline en erreur")
