#!/usr/bin/env python3
"""Génère out/settings.json (statusline, et hooks pour la variante settings-hooks) et out/plugin/.

Usage : make_config.py <plugin|settings-hooks> <délai_PermissionRequest_en_s>
Le modèle est plugin/hooks/hooks.json ; on y remplace le chemin du relais (absolu) et le délai
(un champ `timeout` JSON ne peut pas lire une variable d'environnement).
"""
import json
import os
import shutil
import sys

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(SPIKE_DIR, "out")
TEMPLATE = os.path.join(SPIKE_DIR, "plugin")


def build_hooks(timeout):
    with open(os.path.join(TEMPLATE, "hooks", "hooks.json"), encoding="utf-8") as f:
        hooks = json.load(f)["hooks"]
    relay = os.path.join(SPIKE_DIR, "relay.py")
    for groups in hooks.values():
        for group in groups:
            for h in group["hooks"]:
                h["args"] = [relay if a == "${CLAUDE_PLUGIN_ROOT}/../relay.py" else a for a in h["args"]]
                if h["args"][1] == "PermissionRequest":
                    h["timeout"] = timeout
                    h["args"][2] = str(timeout)
    return hooks


def main():
    variant, timeout = sys.argv[1], int(sys.argv[2])
    hooks = build_hooks(timeout)
    settings = {"statusLine": {"type": "command", "command": f"python3 '{SPIKE_DIR}/statusline.py'"}}
    if variant == "settings-hooks":
        settings["hooks"] = hooks
    else:
        dest = os.path.join(OUT, "plugin")
        shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(os.path.join(TEMPLATE, ".claude-plugin"), os.path.join(dest, ".claude-plugin"))
        os.makedirs(os.path.join(dest, "hooks"))
        with open(os.path.join(dest, "hooks", "hooks.json"), "w", encoding="utf-8") as f:
            json.dump({"hooks": hooks}, f, indent=2, ensure_ascii=False)
    with open(os.path.join(OUT, "settings.json"), "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
