#!/usr/bin/env python3
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

home = Path.home()
root = home / ".local/state/super-space/clipboard-validation"
binary = home / ".local/bin/super-space"
unit = "super-space-clipboard-validation"
original = home / ".local/state/omarchy/clipboard-history.json"
history = root / "state/omarchy/clipboard-history.json"
config = home / ".config/super-space/config.toml"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def run(*arguments):
    subprocess.run(arguments, check=True)


def restore():
    subprocess.run(["systemctl", "--user", "stop", unit], check=False)
    run("systemctl", "--user", "start", "super-space")


if sys.argv[1:] == ["prepare"]:
    history.parent.mkdir(parents=True, exist_ok=True)
    (root / "data").mkdir(exist_ok=True)
    (root / "snapshot.json").write_text(json.dumps({"history": digest(original), "config": digest(config)}))
    history.write_text(json.dumps([{"type": "text", "text": "Disposable clipboard validation one"}, {"type": "text", "text": "Disposable clipboard validation two"}]))
    run("systemctl", "--user", "stop", "super-space")
    try:
        run("systemd-run", "--user", "--quiet", "--collect", f"--unit={unit}", f"--setenv=XDG_STATE_HOME={root}/state", f"--setenv=XDG_DATA_HOME={root}/data", f"--setenv=PATH={home}/.local/bin:{home}/.local/share/mise/shims:/usr/share/omarchy/bin:/usr/bin", str(binary), "daemon")
        for _ in range(100):
            if subprocess.run([str(binary), "ping"], stdout=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("Isolated clipboard launcher did not start")
        run(str(binary), "show", "builtin:clipboard")
        print("Isolated clipboard history is ready for native clear/cancel testing.")
    except BaseException:
        restore()
        raise
elif sys.argv[1:] == ["finish"]:
    try:
        assert json.loads(history.read_text()) == [], "The fixture history was not cleared"
        before = json.loads((root / "snapshot.json").read_text())
        assert before == {"history": digest(original), "config": digest(config)}, "Original user data changed"
        print("Native clear history passed; original clipboard history and settings are unchanged.")
    finally:
        restore()
elif sys.argv[1:] == ["restore"]:
    restore()
else:
    raise SystemExit("Use prepare, finish, or restore")
