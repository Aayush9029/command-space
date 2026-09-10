#!/bin/bash
set -euo pipefail
[[ "$#" == 1 && "$1" == --prebuilt ]]
printf 'installed\n' > "$HOME/install-result"
printf '%s\n' "$*" >> "$SUPER_SPACE_BOOTSTRAP_CALLS"
