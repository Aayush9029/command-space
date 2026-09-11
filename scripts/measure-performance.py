#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket
import statistics
import subprocess
import time

command_socket = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "super-space.sock"


def send(command):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(command_socket))
        connection.sendall((json.dumps({"command": command, "route": "root"}) + "\n").encode())


def mapped():
    windows = json.loads(subprocess.check_output(["hyprctl", "-j", "clients"]))
    return any(window.get("class") == "super-space" and window.get("mapped") for window in windows)


def wait_for(expected):
    deadline = time.monotonic() + 10
    while mapped() != expected:
        if time.monotonic() > deadline:
            raise TimeoutError("Launcher did not reach the expected window state")
        time.sleep(0.002)


def percentile(values, fraction):
    return round(sorted(values)[min(len(values)-1, int(len(values)*fraction))], 2)


def process_cpu(stat):
    fields = stat.rsplit(")", 1)[1].split()
    return fields[19], (int(fields[11]) + int(fields[12])) * 1_000_000 / os.sysconf("SC_CLK_TCK")


def cpu_percent(before, after, field="service_cpu_usec"):
    elapsed = after["time"] - before["time"]
    delta = after[field] - before[field]
    if elapsed <= 0 or delta < 0:
        raise RuntimeError("CPU measurement counters changed unexpectedly")
    return delta / (elapsed * 10_000)


def quiet_window(samples, consecutive, threshold):
    if len(samples) < consecutive + 1:
        return False
    window = samples[-consecutive - 1:]
    return (
        all(sample["processes"] == window[0]["processes"] for sample in window[1:])
        and all(cpu_percent(before, after) <= threshold for before, after in zip(window, window[1:]))
    )


def wait_for_quiet(sample, timeout=60, interval=2, consecutive=3, threshold=5,
                   clock=time.monotonic, sleep=time.sleep):
    started = clock()
    samples = [sample()]
    settled = False
    while clock() - started < timeout:
        sleep(min(interval, max(0, timeout - (clock() - started))))
        samples.append(sample())
        if quiet_window(samples, consecutive, threshold):
            settled = True
            break
    return {
        "settled": settled,
        "settle_wait_seconds": round(clock() - started, 3),
        "settle_timeout_seconds": timeout,
        "required_consecutive_samples": consecutive,
        "sample_interval_seconds": interval,
        "quiet_service_cpu_threshold_percent_of_one_core": threshold,
        "service_cpu_samples_percent_of_one_core": [
            round(cpu_percent(before, after), 3) for before, after in zip(samples, samples[1:])
        ],
    }


def main():
    send("hide")
    wait_for(False)
    started = time.perf_counter()
    subprocess.run(["systemctl", "--user", "restart", "super-space.service"], check=True)
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
    service = dict(line.split("=", 1) for line in subprocess.check_output(
        ["systemctl", "--user", "show", "super-space.service", "-p", "ControlGroup", "-p", "MainPID"], text=True
    ).splitlines())
    cgroup = Path("/sys/fs/cgroup") / service["ControlGroup"].lstrip("/")
    process_stat = Path("/proc") / service["MainPID"] / "stat"
    expected_start, _ = process_cpu(process_stat.read_text())

    def sample():
        processes = tuple(sorted((cgroup / "cgroup.procs").read_text().split()))
        cpu = dict(line.split() for line in (cgroup / "cpu.stat").read_text().splitlines())
        process_start, native_cpu = process_cpu(process_stat.read_text())
        if process_start != expected_start or service["MainPID"] not in processes:
            raise RuntimeError("Launcher process changed during measurement")
        return {"time": time.monotonic(), "service_cpu_usec": int(cpu["usage_usec"]),
                "native_cpu_usec": native_cpu, "processes": processes}

    idle_sampling = wait_for_quiet(sample)
    before = sample()
    time.sleep(10)
    after = sample()
    idle_sampling["measurement_window_seconds"] = round(after["time"] - before["time"], 3)
    idle_sampling["service_processes_unchanged_during_measurement"] = before["processes"] == after["processes"]
    result = {
        "cold_restart_to_mapped_window_ms": round(cold, 2),
        "warm_show_to_mapped_window_ms": {"samples": len(warm), "median": round(statistics.median(warm), 2), "p95": percentile(warm, 0.95), "maximum": round(max(warm), 2)},
        "hidden_service_cpu_percent_of_one_core": round(cpu_percent(before, after), 3),
        "hidden_native_cpu_percent_of_one_core": round(cpu_percent(before, after, "native_cpu_usec"), 3),
        "service_memory_mib": round(int((cgroup/"memory.current").read_text()) / 1024**2, 2),
        "idle_sampling": idle_sampling,
        "measurement": "Guest IPC to Hyprland mapped-window observation, including polling overhead; not display frame latency. Service memory and CPU include background extension workers. Native CPU includes launcher threads, excluding child processes. Settled requires unchanged service processes and three samples below the reported CPU threshold; a timeout leaves settled false."
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
