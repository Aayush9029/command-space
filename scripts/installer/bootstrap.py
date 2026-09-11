import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import zipfile

REPOSITORY = "Aayush9029/super-space"
BUN_RELEASE = "1.4.2"
BUN_ARCHIVES = {
    "aarch64": (
        "bun-linux-aarch64",
        "54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7",
    ),
    "x86_64": (
        "bun-linux-x64-baseline",
        "c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f",
    ),
}
RUNTIME_PACKAGES = ("rsync", "util-linux", "desktop-file-utils", "wayland", "libxkbcommon")


def digest_matches(path, expected):
    with open(path, "rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise ValueError("Download checksum does not match")


def safe_path(name, root):
    path = pathlib.PurePosixPath(name)
    if (
        not name or "\\" in name or path.is_absolute() or ".." in path.parts
        or not path.parts or path.parts[0] != root
    ):
        raise ValueError("Archive contains an invalid path")
    return path


def release_plan(metadata, arch):
    with open(metadata, encoding="utf-8") as source:
        release = json.load(source)
    tag = release.get("tag_name", "")
    if (
        not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag)
        or tuple(map(int, tag[1:].split("."))) < (1, 0, 3)
    ):
        raise ValueError("A Bun-compatible Super Space release (1.0.3 or newer) is not available yet")
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Expected a stable published release")
    name = f"super-space-{tag[1:]}-linux-{arch}.tar.gz"
    urls = []
    for asset_name in (name, name + ".sha256"):
        matches = [asset for asset in release.get("assets", []) if asset.get("name") == asset_name]
        expected = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{asset_name}"
        if len(matches) != 1 or matches[0].get("browser_download_url") != expected:
            raise ValueError(f"Missing or invalid release asset: {asset_name}")
        urls.append(expected)
    return tag[1:], name, *urls


def unpack_package(archive, checksum, name, destination, arch):
    checksum_text = pathlib.Path(checksum).read_text(encoding="ascii")
    match = re.fullmatch(r"([a-fA-F0-9]{64})[ \t]+\*?" + re.escape(name) + r"\r?\n?", checksum_text)
    if not match:
        raise ValueError("Invalid release checksum file")
    digest_matches(archive, match[1].lower())
    with tarfile.open(archive, "r:gz") as bundle:
        members, paths, total = [], set(), 0
        for member in bundle:
            path = safe_path(member.name, "super-space")
            if path in paths or not (member.isfile() or member.isdir()):
                raise ValueError("Archive contains duplicate paths, links, or special files")
            paths.add(path)
            total += member.size
            if (
                member.size < 0 or member.size > 128 * 1024 * 1024
                or total > 512 * 1024 * 1024 or len(members) >= 10000
            ):
                raise ValueError("Archive exceeds extraction limits")
            member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
            members.append(member)
        required = ("scripts/install-linux.sh", "bin/super-space", "runtime/bun.lock")
        if not any(member.isfile() and member.name in ("super-space/runtime/host.ts", "super-space/runtime/host.mjs") for member in members):
            raise ValueError("Package is incomplete: missing extension runtime")
        for relative in required:
            if not any(member.name.rstrip("/") == f"super-space/{relative}" and member.isfile() for member in members):
                raise ValueError(f"Package is incomplete: missing {relative}")
        executable = next(member for member in members if member.name == "super-space/bin/super-space")
        with bundle.extractfile(executable) as source:
            header = source.read(20)
        machine = {"x86_64": 62, "aarch64": 183}[arch]
        if (
            len(header) < 20 or header[:6] != b"\x7fELF\x02\x01"
            or int.from_bytes(header[18:20], "little") != machine
            or not executable.mode & 0o111
        ):
            raise ValueError("Package executable does not match the Linux architecture")
        bundle.extractall(destination, members=members, filter="data")


def unpack_bun(archive, digest, root, destination):
    digest_matches(archive, digest)
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > 50 or sum(entry.file_size for entry in entries) > 256 * 1024 * 1024:
            raise ValueError("Bun archive exceeds extraction limits")
        paths = set()
        for entry in entries:
            path = safe_path(entry.filename, root)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (
                path in paths or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                or entry.file_size > 128 * 1024 * 1024
            ):
                raise ValueError("Bun archive contains invalid entries")
            paths.add(path)
        binary = bundle.getinfo(f"{root}/bun")
        if binary.is_dir() or binary.file_size == 0:
            raise ValueError("Bun executable is missing")
        with bundle.open(binary) as source, open(destination, "xb") as target:
            shutil.copyfileobj(source, target)
        pathlib.Path(destination).chmod(0o755)


def output(*command):
    return subprocess.check_output(command, text=True).strip()


def require_commands(*commands):
    for command in commands:
        if shutil.which(command) is None:
            raise ValueError(f"Missing {command}. Install it with pacman and retry (Python uses the python package).")


def check_environment():
    if sys.version_info < (3, 12):
        raise ValueError("Python 3.12 or newer is required.")
    if output("uname", "-s") != "Linux":
        raise ValueError("Run this installer on your Omarchy Linux desktop.")
    if output("id", "-u") == "0":
        raise ValueError("Run as your desktop user, without sudo.")
    arch = output("uname", "-m")
    if arch not in BUN_ARCHIVES:
        raise ValueError(f"Unsupported architecture: {arch}.")
    home = pathlib.Path.home()
    if not (home / ".config/hypr/hyprland.lua").is_file():
        raise ValueError("Omarchy's Hyprland Lua configuration was not found.")
    for setting, relative in (
        ("XDG_CONFIG_HOME", ".config"),
        ("XDG_DATA_HOME", ".local/share"),
        ("XDG_STATE_HOME", ".local/state"),
    ):
        expected = str(home / relative)
        if os.environ.get(setting) not in (None, "", expected):
            raise ValueError(f"{setting} must use {expected} for Omarchy desktop integration.")
    require_commands("curl", "pacman", "systemctl")
    try:
        session = output("systemctl", "--user", "show-environment")
    except subprocess.CalledProcessError as error:
        raise ValueError("The systemd user session is unavailable.") from error
    if not any(line.startswith(("WAYLAND_DISPLAY=", "HYPRLAND_INSTANCE_SIGNATURE=")) for line in session.splitlines()):
        raise ValueError("Run this installer from your active Omarchy desktop session.")
    os.environ["PATH"] = f"{home}/.bun/bin:{os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin')}"
    return arch


def download(url, destination, limit):
    subprocess.run([
        "curl", "--fail", "--location", "--silent", "--show-error",
        "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
        "--connect-timeout", "20", "--max-time", "300", "--retry", "2",
        "--max-filesize", str(limit), "--output", str(destination), url,
    ], check=True)


def download_release(staging, arch):
    print("Finding the latest Super Space release...", flush=True)
    metadata = staging / "release.json"
    download(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", metadata, 1048576)
    version, name, package_url, checksum_url = release_plan(metadata, arch)
    print(f"Downloading Super Space {version}...", flush=True)
    archive, checksum = staging / name, staging / "checksum"
    download(package_url, archive, 134217728)
    download(checksum_url, checksum, 4096)
    unpack_package(archive, checksum, name, staging / "unpacked", arch)
    return version, staging / "unpacked/super-space"


def bun_is_compatible():
    if shutil.which("bun") is None:
        return False
    try:
        version = subprocess.check_output(["bun", "--version"], text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return False
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        return False
    return tuple(map(int, version.split("."))) >= (1, 4, 2)


def download_bun(staging, arch):
    name, digest = BUN_ARCHIVES[arch]
    print(f"Downloading Bun {BUN_RELEASE}...", flush=True)
    archive, binary = staging / "bun.zip", staging / "bun"
    download(f"https://github.com/oven-sh/bun/releases/download/bun-v{BUN_RELEASE}/{name}.zip", archive, 134217728)
    unpack_bun(archive, digest, name, binary)
    if output(str(binary), "--version") != BUN_RELEASE:
        raise ValueError("The downloaded Bun executable cannot run on this system.")
    return binary


def install_system_packages():
    missing = [
        package for package in RUNTIME_PACKAGES
        if subprocess.run(["pacman", "-Q", package], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
    ]
    if not missing:
        return
    if shutil.which("sudo") is None:
        raise ValueError("sudo is required to install missing runtime packages.")
    try:
        terminal = open("/dev/tty", "rb")
    except OSError as error:
        raise ValueError(f"Install these packages with pacman and retry: {' '.join(missing)}") from error
    print(f"Installing required packages: {' '.join(missing)}", flush=True)
    with terminal:
        subprocess.run(["sudo", "pacman", "-S", "--needed", "--noconfirm", *missing], stdin=terminal, check=True)


def install_bun(binary):
    directory = pathlib.Path.home() / ".bun/bin"
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".super-space-bun.", dir=directory)
    os.close(descriptor)
    temporary = pathlib.Path(temporary)
    try:
        shutil.copyfile(binary, temporary)
        temporary.chmod(0o755)
        temporary.replace(directory / "bun")
    finally:
        temporary.unlink(missing_ok=True)


def interrupt(signum, frame):
    raise SystemExit(128 + signum)


def main():
    arch = check_environment()
    os.umask(0o077)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    with tempfile.TemporaryDirectory(prefix="super-space-") as directory:
        staging = pathlib.Path(directory)
        version, package = download_release(staging, arch)
        bun = None if bun_is_compatible() else download_bun(staging, arch)
        install_system_packages()
        if output(str(package / "bin/super-space"), "--version") != f"Super Space {version}":
            raise ValueError("The package executable does not match the release version or cannot run on this system.")
        if bun is not None:
            install_bun(bun)
        print("Installing Super Space...", flush=True)
        subprocess.run(["bash", str(package / "scripts/install-linux.sh"), "--prebuilt"], check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile, subprocess.CalledProcessError) as error:
        sys.exit(f"Super Space: {error}")
