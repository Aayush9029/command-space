#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
version=$(cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])')
arch=$(uname -m)
case "$arch" in aarch64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; exit 1;; esac
nice -n 10 cargo build --release --locked --bin command-space
bun install --cwd runtime --production --frozen-lockfile --ignore-scripts
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
package="$staging/command-space"
mkdir -p "$package/bin" "$package/runtime" "$package/scripts" "$package/extensions" "$package/docs/assets" dist
install -m 755 target/release/command-space "$package/bin/command-space"
rsync -a --exclude tests --exclude browser-host --exclude browser-extension-firefox runtime/ "$package/runtime/"
cp scripts/compat/v1.0.1-package-lock.json "$package/runtime/package-lock.json"
install -m 755 scripts/install.sh scripts/install-linux.sh scripts/start-daemon.sh "$package/scripts/"
rsync -a --exclude node_modules --exclude .git extensions/ "$package/extensions/"
cp README.md LICENSE.md "$package/"
cp docs/DEVELOPMENT.md docs/PORTING.md "$package/docs/"
cp docs/assets/banner.png "$package/docs/assets/"
archive="command-space-$version-linux-$arch.tar.gz"
tar --format=ustar --dereference --hard-dereference -czf "dist/$archive" -C "$staging" command-space
(cd dist && sha256sum "$archive" > "$archive.sha256")
bun scripts/verify-linux-package.mjs "dist/$archive"
bun scripts/verify-installer.mjs "dist/$archive"
bun scripts/verify-bootstrap.mjs "dist/$archive"
printf 'Created dist/%s\n' "$archive"
