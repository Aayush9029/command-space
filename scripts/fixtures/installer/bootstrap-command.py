#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import sys


def download(arguments):
    assert arguments[arguments.index("--proto") + 1] == "=https"
    assert arguments[arguments.index("--proto-redir") + 1] == "=https"
    routes = json.loads(Path(os.environ["CS_TEST_TRANSPORT"]).read_text())
    url = arguments[-1]
    if url not in routes:
        sys.exit(f"Unexpected download: {url}")
    if os.environ.get("CS_TEST_FAILED_DOWNLOAD") == url:
        print("curl: simulated download failure", file=sys.stderr)
        sys.exit(22)
    source = Path(routes[url])
    destination = arguments[arguments.index("--output") + 1]
    limit = int(arguments[arguments.index("--max-filesize") + 1])
    assert source.stat().st_size <= limit
    shutil.copyfile(source, destination)


def main():
    command = Path(sys.argv[0]).name
    arguments = sys.argv[1:]
    with open(os.environ["SUPER_SPACE_BOOTSTRAP_CALLS"], "a") as log:
        log.write(json.dumps([command, *arguments]) + "\n")

    if command == "uname":
        print(os.environ.get("CS_TEST_OS", "Linux") if arguments == ["-s"] else os.environ["CS_TEST_ARCH"])
    elif command == "id":
        print(os.environ.get("CS_TEST_UID", "1000"))
    elif command == "systemctl":
        if os.environ.get("CS_TEST_NO_SESSION"):
            sys.exit(1)
        print("WAYLAND_DISPLAY=wayland-test")
    elif command == "pacman":
        sys.exit(1 if os.environ.get("CS_TEST_MISSING_DEPS") else 0)
    elif command == "sudo":
        sys.exit(99)
    elif command == "curl":
        download(arguments)


if __name__ == "__main__":
    main()
