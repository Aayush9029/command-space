#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import time

command_socket = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "command-space.sock"


def send(command):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(command_socket))
        connection.sendall((json.dumps({"command": command, "route": "root"}) + "\n").encode())


def mapped():
    windows = json.loads(subprocess.check_output(["hyprctl", "-j", "clients"]))
    return any(window.get("class") == "command-space" and window.get("mapped") for window in windows)


def wait_for(expected):
    deadline = time.monotonic() + 10
    while mapped() != expected:
        if time.monotonic() > deadline:
            raise TimeoutError("Launcher did not reach the expected window state")
        time.sleep(0.002)


def percentile(values, fraction):
    return round(sorted(values)[min(len(values)-1, int(len(values)*fraction))], 2)


send("hide")
wait_for(False)
started = time.perf_counter()
subprocess.run(["systemctl", "--user", "restart", "command-space.service"], check=True)
deadline = time.monotonic() + 10
while True:
    try:
        send("show")
        break
    except OSError:
        if time.monotonic() > deadline:
            raise
        time.sleep(0.01)
wait_for(True)
cold = (time.perf_counter()-started)*1000
time.sleep(1)
warm = []
for _ in range(20):
    send("hide")
    wait_for(False)
    time.sleep(0.05)
    started = time.perf_counter()
    send("show")
    wait_for(True)
    warm.append((time.perf_counter()-started)*1000)
send("hide")
wait_for(False)
group = subprocess.check_output(["systemctl", "--user", "show", "command-space.service", "-p", "ControlGroup", "--value"], text=True).strip()
cgroup = Path("/sys/fs/cgroup") / group.lstrip("/")


def cpu():
    return int(dict(line.split() for line in (cgroup / "cpu.stat").read_text().splitlines())["usage_usec"])


time.sleep(10)
start_cpu = cpu()
start_time = time.monotonic()
time.sleep(10)
cpu_percent = (cpu()-start_cpu) / ((time.monotonic()-start_time)*10000)
result = {
    "cold_restart_to_mapped_window_ms": round(cold, 2),
    "warm_show_to_mapped_window_ms": {"samples": len(warm), "median": round(statistics.median(warm), 2), "p95": percentile(warm, 0.95), "maximum": round(max(warm), 2)},
    "hidden_service_cpu_percent_of_one_core": round(cpu_percent, 3),
    "service_memory_mib": round(int((cgroup/"memory.current").read_text()) / 1024**2, 2),
    "measurement": "Guest IPC to Hyprland mapped-window observation, including polling overhead; not display frame latency. Service memory and CPU include background extension workers."
}
print(json.dumps(result, indent=2))
