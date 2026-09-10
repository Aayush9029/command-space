#!/usr/bin/env bash
set -euo pipefail

readonly bootstrap_url=https://raw.githubusercontent.com/Aayush9029/super-space/master/scripts/installer/bootstrap.py
# Pin the helper contents so an unexpected download never runs.
readonly bootstrap_sha256=ac11f2e557a5e4f24960ab2d9f54bc8842f3d0ef57e4f6c50154544fded93938

fail() {
  printf 'Super Space: %s\n' "$*" >&2
  exit 1
}

[[ $(uname -s) == Linux ]] || fail 'Run this installer on your Omarchy Linux desktop.'
[[ $(id -u) != 0 ]] || fail 'Run as your desktop user, without sudo.'
arch=$(uname -m)
case "$arch" in aarch64|x86_64) ;; *) fail "Unsupported architecture: $arch." ;; esac
for dependency in curl python3 sha256sum mktemp; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Missing $dependency. Install it with pacman and retry (Python uses the python package)."
done

umask 077
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
  --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 --max-filesize 1048576 \
  --output "$staging/bootstrap.py" "$bootstrap_url"
checksum=$(sha256sum < "$staging/bootstrap.py")
[[ ${checksum%% *} == "$bootstrap_sha256" ]] || fail 'Installer helper checksum does not match. Retry with the current install.sh.'
python3 "$staging/bootstrap.py"
