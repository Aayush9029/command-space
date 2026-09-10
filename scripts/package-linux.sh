#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
version=$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])')
arch=$(uname -m)
case "$arch" in aarch64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; exit 1;; esac
nice -n 10 cargo build --release --locked --bin command-space
npm ci --prefix runtime --omit=dev --ignore-scripts --no-audit --no-fund
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
package="$staging/command-space"
mkdir -p "$package/bin" "$package/runtime" "$package/scripts" "$package/extensions" dist
install -m 755 target/release/command-space "$package/bin/command-space"
rsync -a --exclude tests --exclude browser-host --exclude browser-extension-firefox runtime/ "$package/runtime/"
install -m 755 scripts/install-linux.sh scripts/start-daemon.sh "$package/scripts/"
cp -R extensions/developer-tools "$package/extensions/"
cp README.md LICENSE.md "$package/"
archive="command-space-$version-linux-$arch.tar.gz"
tar --format=ustar --dereference --hard-dereference -czf "dist/$archive" -C "$staging" command-space
(cd dist && sha256sum "$archive" > "$archive.sha256")
printf 'Created dist/%s\n' "$archive"
