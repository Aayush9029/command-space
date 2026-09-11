#!/usr/bin/env python3
import argparse
import http.server
import json
from pathlib import Path
import secrets
import socket
import subprocess
import threading
import time
import urllib.parse


parser = argparse.ArgumentParser()
parser.add_argument("--qmp")
parser.add_argument("--self-test", action="store_true")
parser.add_argument("--port", type=int, default=8766)
parser.add_argument("--vm", default="omarchy")
args = parser.parse_args()
if not args.self_test and not args.qmp:
    parser.error("--qmp is required unless --self-test is used")
token = secrets.token_urlsafe(24)
lock = threading.Lock()


def qmp(commands):
    with lock, socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(args.qmp)
        with connection.makefile("rwb", buffering=0) as stream:
            stream.readline()
            result = None
            for command in [{"execute": "qmp_capabilities"}] + commands:
                stream.write((json.dumps(command) + "\n").encode())
                while True:
                    response = json.loads(stream.readline())
                    if "error" in response:
                        raise RuntimeError(response["error"])
                    if "return" in response:
                        result = response["return"]
                        break
                if command["execute"] == "input-send-event":
                    time.sleep(0.025)
            return result


def input_events(events):
    return {"execute": "input-send-event", "arguments": {"events": events}}


PAGE = '''<!doctype html><html><meta charset="utf-8"><title>Super Space — live Omarchy VM</title>
<style>body{margin:0;background:#101116;color:#b4bee6;font:13px monospace}header{display:flex;gap:14px;align-items:center;padding:10px 14px}button,input{background:#24283b;color:#c0caf5;border:1px solid #414868;padding:7px;font:inherit}input{flex:1}canvas{display:block;width:100%;outline:0;user-select:none}small{color:#7aa2f7}</style>
<header><strong>Live Omarchy VM</strong><input id="typing" aria-label="Type into VM" placeholder="Type into the focused guest field"><button id="send">Type</button><button data-key="ret">Enter</button><button data-key="esc">Escape</button><button data-key="up">↑</button><button data-key="down">↓</button><small id="status">Connecting</small></header>
<header><button data-chord="meta_l,spc">Super+Space</button><button data-chord="meta_l,ctrl,v">Clipboard</button><button data-chord="meta_l,ctrl,e">Emoji</button><button data-chord="ctrl,k">Actions</button><button data-chord="ctrl,a">Select All</button><button data-key="tab">Tab</button><button data-chord="shift,tab">Shift+Tab</button><button data-key="spc">Space</button><button data-chord="ctrl,e">Ctrl+E</button><button data-key="pgdn">Page Down</button><button data-key="pgup">Page Up</button><button id="refresh">Refresh view</button></header>
<canvas id="screen" tabindex="0" aria-label="Live Omarchy desktop"></canvas>
<script src="/client.js?token=__TOKEN__" defer></script></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def authorized(self):
        return secrets.compare_digest(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("token", [""])[0], token)

    def respond(self, status, mime, body):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            return self.respond(403, "text/plain", b"Forbidden")
        if urllib.parse.urlparse(self.path).path == "/frame":
            try:
                frame = subprocess.run(["ssh", "-o", "BatchMode=yes", args.vm, "systemd-run --user --quiet --wait --pipe --collect /usr/bin/timeout 4 /usr/bin/grim -l 1 -"], capture_output=True, check=True, timeout=8)
                self.respond(200, "image/png", frame.stdout)
            except Exception as error:
                self.respond(500, "text/plain", str(error).encode())
        elif urllib.parse.urlparse(self.path).path == "/client.js":
            self.respond(200, "text/javascript; charset=utf-8", client)
        else:
            self.respond(200, "text/html; charset=utf-8", PAGE.replace("__TOKEN__", token).encode())

    def do_POST(self):
        if not self.authorized() or int(self.headers.get("Content-Length", "0")) > 16384:
            return self.respond(403, "text/plain", b"Forbidden")
        try:
            message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            commands = []

            def key(name, down):
                commands.append(input_events([{"type": "key", "data": {"down": down, "key": {"type": "qcode", "data": name}}}]))

            if message["type"] == "click":
                axes = [{"type": "abs", "data": {"axis": axis, "value": int(max(0, min(1, message[axis])) * 32767)}} for axis in ("x", "y")]
                commands.append(input_events(axes))
                for down in (True, False):
                    commands.append(input_events([{"type": "btn", "data": {"button": "left", "down": down}}]))
            elif message["type"] in ("key", "key-state"):
                if message["type"] == "key-state":
                    key(message["key"], bool(message["down"]))
                else:
                    key(message["key"], True)
                    key(message["key"], False)
            elif message["type"] == "chord":
                for name in message["keys"]:
                    key(name, True)
                for name in reversed(message["keys"]):
                    key(name, False)
            elif message["type"] == "wheel":
                for _ in range(3):
                    for down in (True, False):
                        commands.append(input_events([{"type": "btn", "data": {"button": message["direction"], "down": down}}]))
            elif message["type"] == "text":
                plain = {" ": "spc", "\n": "ret", "\t": "tab", "-": "minus", "=": "equal", ",": "comma", ".": "dot", "/": "slash", ";": "semicolon", "'": "apostrophe", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", "`": "grave_accent"}
                shifted = dict(zip('!@#$%^&*()_+<>?:"{}|~', ['1','2','3','4','5','6','7','8','9','0','minus','equal','comma','dot','slash','semicolon','apostrophe','bracket_left','bracket_right','backslash','grave_accent']))
                for character in message["text"]:
                    shift = character.isupper() or character in shifted
                    name = shifted.get(character, plain.get(character, character.lower()))
                    if not character.isascii():
                        raise ValueError("Use the VM clipboard for non-ASCII text")
                    if shift:
                        key("shift", True)
                    key(name, True)
                    key(name, False)
                    if shift:
                        key("shift", False)
            qmp(commands)
            self.respond(200, "application/json", b'{"ok":true}')
        except Exception as error:
            self.respond(400, "text/plain", str(error).encode())


def compile_client():
    source = Path(__file__).with_name("vm-viewer-client.ts")
    result = subprocess.run(
        ["bun", "build", str(source), "--target=browser", "--format=iife"],
        capture_output=True,
        check=True,
        timeout=30,
    )
    if not result.stdout:
        raise RuntimeError("Bun produced an empty VM viewer client")
    return result.stdout


client = compile_client()
if args.self_test:
    subprocess.run(["bun", "test", str(Path(__file__).with_name("vm-viewer-frame-queue.test.ts"))], check=True)
else:
    print(f"http://127.0.0.1:{args.port}/?token={token}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
