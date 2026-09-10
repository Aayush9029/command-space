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
mkdir -p "$package/bin" "$package/runtime" "$package/scripts" "$package/extensions" "$package/docs/assets" dist
install -m 755 target/release/command-space "$package/bin/command-space"
rsync -a --exclude tests --exclude browser-host --exclude browser-extension-firefox runtime/ "$package/runtime/"
install -m 755 scripts/install-linux.sh scripts/start-daemon.sh "$package/scripts/"
rsync -a --exclude node_modules --exclude .git extensions/ "$package/extensions/"
cp README.md LICENSE.md "$package/"
cp docs/DEVELOPMENT.md docs/PORTING.md "$package/docs/"
cp docs/assets/launcher-dark.png "$package/docs/assets/"
archive="command-space-$version-linux-$arch.tar.gz"
tar --format=ustar --dereference --hard-dereference -czf "dist/$archive" -C "$staging" command-space
(cd dist && sha256sum "$archive" > "$archive.sha256")
node scripts/verify-linux-package.mjs "dist/$archive"
node scripts/verify-installer.mjs "dist/$archive"
printf 'Created dist/%s\n' "$archive"
