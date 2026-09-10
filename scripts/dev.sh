#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
vm_host=${SUPER_SPACE_VM:-omarchy}
vm_dir=Developer/super-space
ssh "$vm_host" "mkdir -p $vm_dir"
rsync -az --exclude .git --exclude target --exclude dist --exclude node_modules --exclude .local "$project_dir/" "$vm_host:$vm_dir/"
if [ "$#" -eq 0 ]; then
  set -- cargo build --bin super-space
fi
if [ "$1" = cargo ]; then
  set -- nice -n 10 "$@"
fi
printf -v command '%q ' "$@"
ssh "$vm_host" "export PATH=\"\$HOME/.bun/bin:\$HOME/.cargo/bin:\$HOME/.local/share/mise/shims:\$PATH\"; cd $vm_dir; $command"
