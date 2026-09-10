#!/usr/bin/env bash
set -euo pipefail

readonly repository=Aayush9029/super-space
readonly bun_release=1.4.2
# SHA-256 of the official Bun release archives, pinned with bun_release.
readonly bun_aarch64_sha256=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7
readonly bun_x86_64_sha256=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f
staging=
bun_staging=

fail() {
  printf 'Super Space: %s\n' "$*" >&2
  exit 1
}

download() {
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 --max-filesize "$3" \
    --output "$2" "$1"
}

check_environment() {
  [[ $(uname -s) == Linux ]] || fail 'Run this installer on your Omarchy Linux desktop.'
  [[ $(id -u) != 0 ]] || fail 'Run as your desktop user, without sudo.'
  local session setting expected dependency
  arch=$(uname -m)
  case "$arch" in
    aarch64)
      bun_asset=bun-linux-aarch64
      bun_digest=$bun_aarch64_sha256
      ;;
    x86_64)
      bun_asset=bun-linux-x64-baseline
      bun_digest=$bun_x86_64_sha256
      ;;
    *) fail "Unsupported architecture: $arch." ;;
  esac
  [[ -f "$HOME/.config/hypr/hyprland.lua" ]] || fail "Omarchy's Hyprland Lua configuration was not found."
  for setting in XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME; do
    case "$setting" in
      XDG_CONFIG_HOME) expected="$HOME/.config" ;;
      XDG_DATA_HOME) expected="$HOME/.local/share" ;;
      XDG_STATE_HOME) expected="$HOME/.local/state" ;;
    esac
    [[ -z "${!setting:-}" || "${!setting}" == "$expected" ]] || fail "$setting must use $expected for Omarchy desktop integration."
  done
  for dependency in curl python3 pacman systemctl mktemp; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Missing $dependency. Install it with pacman and retry (Python uses the python package)."
  done
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 12))' || fail 'Python 3.12 or newer is required.'
  session=$(systemctl --user show-environment) || fail 'The systemd user session is unavailable.'
  [[ "$session" == *WAYLAND_DISPLAY=* || "$session" == *HYPRLAND_INSTANCE_SIGNATURE=* ]] || fail 'Run this installer from your active Omarchy desktop session.'
  export PATH="$HOME/.bun/bin:${PATH:-/usr/local/bin:/usr/bin:/bin}"
}

cleanup() {
  [[ -z "$staging" ]] || rm -rf -- "$staging"
  [[ -z "$bun_staging" ]] || rm -f -- "$bun_staging"
}

prepare_staging() {
  umask 077
  staging=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

download_release() {
  printf 'Finding the latest Super Space release...\n'
  download "https://api.github.com/repos/$repository/releases/latest" "$staging/release.json" 1048576
  verify_download release "$staging/release.json" "$arch" > "$staging/release-plan"
  { read -r version; read -r archive; read -r package_url; read -r checksum_url; } < "$staging/release-plan"
  printf 'Downloading Super Space %s...\n' "$version"
  download "$package_url" "$staging/$archive" 134217728
  download "$checksum_url" "$staging/checksum" 4096
  verify_download package "$staging/$archive" "$staging/checksum" "$archive" "$staging/unpacked" "$arch"
}

bun_is_compatible() {
  local version
  command -v bun >/dev/null 2>&1 || return 1
  version=$(bun --version 2>/dev/null) || return 1
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || return 1
  local major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
  (( major > 1 || (major == 1 && minor > 4) || (major == 1 && minor == 4 && patch >= 2) ))
}

download_bun() {
  printf 'Downloading Bun %s...\n' "$bun_release"
  download "https://github.com/oven-sh/bun/releases/download/bun-v$bun_release/$bun_asset.zip" "$staging/bun.zip" 134217728
  verify_download bun "$staging/bun.zip" "$bun_digest" "$bun_asset" "$staging/bun"
  [[ $("$staging/bun" --version) == "$bun_release" ]] || fail 'The downloaded Bun executable cannot run on this system.'
}

install_system_packages() {
  local packages=() package
  for package in rsync util-linux desktop-file-utils wayland libxkbcommon openssl; do
    pacman -Q "$package" >/dev/null 2>&1 || packages+=("$package")
  done
  if (( ${#packages[@]} )); then
    command -v sudo >/dev/null 2>&1 || fail 'sudo is required to install missing runtime packages.'
    ( : < /dev/tty ) 2>/dev/null || fail "Install these packages with pacman and retry: ${packages[*]}"
    printf 'Installing required packages: %s\n' "${packages[*]}"
    sudo pacman -S --needed --noconfirm "${packages[@]}" < /dev/tty
  fi
}

install_bun() {
  mkdir -p "$HOME/.bun/bin"
  bun_staging=$(mktemp "$HOME/.bun/bin/.super-space-bun.XXXXXX")
  install -m 755 "$staging/bun" "$bun_staging"
  mv -f "$bun_staging" "$HOME/.bun/bin/bun"
  bun_staging=
}

main() {
  [[ $# == 0 ]] || fail 'This installer does not accept arguments.'
  local arch bun_asset bun_digest version archive package_url checksum_url
  check_environment
  prepare_staging
  download_release
  if ! bun_is_compatible; then
    download_bun
  fi
  install_system_packages
  [[ $("$staging/unpacked/super-space/bin/super-space" --version) == "Super Space $version" ]] || fail 'The package executable does not match the release version or cannot run on this system.'
  if [[ -f "$staging/bun" ]]; then
    install_bun
  fi
  printf 'Installing Super Space...\n'
  bash "$staging/unpacked/super-space/scripts/install-linux.sh" --prebuilt
}

# Keep verification inline so curl | bash needs no separately downloaded code.
verify_download() {
  python3 - "$repository" "$@" <<'PY'
import hashlib
import json
import pathlib
import re
import shutil
import stat
import sys
import tarfile
import zipfile


def digest_matches(path, expected):
    with open(path, "rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise ValueError("Download checksum does not match")


def safe_path(name, root):
    path = pathlib.PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != root:
        raise ValueError("Archive contains an invalid path")
    return path


def release_plan(metadata, arch):
    with open(metadata, encoding="utf-8") as source:
        release = json.load(source)
    tag = release.get("tag_name", "")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or tuple(map(int, tag[1:].split("."))) < (1, 0, 3):
        raise ValueError("A Bun-compatible Super Space release (1.0.3 or newer) is not available yet")
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Expected a stable published release")
    name = f"super-space-{tag[1:]}-linux-{arch}.tar.gz"
    urls = []
    for asset_name in (name, name + ".sha256"):
        matches = [asset for asset in release.get("assets", []) if asset.get("name") == asset_name]
        expected = f"https://github.com/{repository}/releases/download/{tag}/{asset_name}"
        if len(matches) != 1 or matches[0].get("browser_download_url") != expected:
            raise ValueError(f"Missing or invalid release asset: {asset_name}")
        urls.append(expected)
    print(tag[1:])
    print(name)
    print("\n".join(urls))


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
            if member.size < 0 or member.size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024 or len(members) >= 10000:
                raise ValueError("Archive exceeds extraction limits")
            member.mode = 0o755 if member.isdir() or member.mode & 0o111 else 0o644
            members.append(member)
        required = ("scripts/install-linux.sh", "bin/super-space", "runtime/bun.lock", "runtime/host.mjs")
        for relative in required:
            if not any(member.name.rstrip("/") == f"super-space/{relative}" and member.isfile() for member in members):
                raise ValueError(f"Package is incomplete: missing {relative}")
        executable = next(member for member in members if member.name == "super-space/bin/super-space")
        with bundle.extractfile(executable) as source:
            header = source.read(20)
        machine = {"x86_64": 62, "aarch64": 183}[arch]
        if len(header) < 20 or header[:6] != b"\x7fELF\x02\x01" or int.from_bytes(header[18:20], "little") != machine or not executable.mode & 0o111:
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
            if path in paths or kind not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.file_size > 128 * 1024 * 1024:
                raise ValueError("Bun archive contains invalid entries")
            paths.add(path)
        binary = bundle.getinfo(f"{root}/bun")
        if binary.is_dir() or binary.file_size == 0:
            raise ValueError("Bun executable is missing")
        with bundle.open(binary) as source, open(destination, "xb") as target:
            shutil.copyfileobj(source, target)
        pathlib.Path(destination).chmod(0o755)


try:
    repository, operation, *arguments = sys.argv[1:]
    {"release": release_plan, "package": unpack_package, "bun": unpack_bun}[operation](*arguments)
except (ValueError, OSError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
    sys.exit(f"Super Space: {error}")
PY
}

main "$@"
