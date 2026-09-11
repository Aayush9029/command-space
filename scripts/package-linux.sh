#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
arch=$(uname -m)
case "$arch" in aarch64|x86_64) ;; *) printf 'Unsupported architecture: %s\n' "$arch" >&2; exit 1;; esac
nice -n 10 cargo build --release --locked --bin super-space
version=$(target/release/super-space --version)
version=${version#Super Space }
bun install --cwd runtime --frozen-lockfile --ignore-scripts
bun run --cwd runtime typecheck
bun run --cwd runtime build
bun install --cwd runtime --production --frozen-lockfile --ignore-scripts
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
package="$staging/super-space"
mkdir -p "$package/bin" "$package/runtime" "$package/scripts" "$package/extensions" "$package/docs/assets" dist
install -m 755 target/release/super-space "$package/bin/super-space"
rsync -a --exclude tests --exclude browser-host --exclude browser-extension-firefox runtime/ "$package/runtime/"
bun scripts/build-package-compatibility.ts "$package/runtime"
install -m 755 scripts/install.sh scripts/install-linux.sh scripts/migrate-legacy.py scripts/start-daemon.sh "$package/scripts/"
rsync -a --exclude __pycache__ scripts/installer/ "$package/scripts/installer/"
rsync -a --exclude node_modules --exclude .git extensions/ "$package/extensions/"
cp README.md LICENSE.md "$package/"
cp docs/DEVELOPMENT.md docs/PORTING.md "$package/docs/"
cp docs/assets/banner.png "$package/docs/assets/"
archive="super-space-$version-linux-$arch.tar.gz"
tar --format=ustar --dereference --hard-dereference -czf "dist/$archive" -C "$staging" super-space
(cd dist && sha256sum "$archive" > "$archive.sha256")
bun scripts/verify-linux-package.ts "dist/$archive"
bun scripts/verify-installer.ts "dist/$archive"
bun scripts/verify-bootstrap.ts "dist/$archive"
printf 'Created dist/%s\n' "$archive"
