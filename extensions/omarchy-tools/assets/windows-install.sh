#!/usr/bin/env bash
set -euo pipefail
IFS= read -r -d '' command_space_ram
IFS= read -r -d '' command_space_cores
IFS= read -r -d '' command_space_disk
IFS= read -r -d '' command_space_username
IFS= read -r -d '' command_space_password

source /usr/bin/omarchy-windows-vm help >/dev/null

gum() {
  local operation=${1:-} argument header=""
  shift || true
  for argument in "$@"; do
    [[ $argument == --header=* ]] && header=${argument#--header=}
  done
  if [[ $operation == choose ]]; then cat >/dev/null; fi
  case "$operation:$header" in
    "choose:How much RAM would you like to allocate to Windows VM?") printf '%s\n' "$command_space_ram" ;;
    "choose:How much disk space would you like to give Windows VM? (64GB+ recommended)") printf '%s\n' "$command_space_disk" ;;
    "input:How many CPU cores would you like to allocate to Windows VM?") printf '%s\n' "$command_space_cores" ;;
    "input:Enter Windows username:") printf '%s\n' "$command_space_username" ;;
    "input:Enter Windows password:") printf '%s\n' "$command_space_password" ;;
    confirm:) [[ ${1:-} == "Proceed with this configuration?" ]] ;;
    style:*) command gum style "$@" ;;
    *) printf 'This Omarchy version requests an unsupported Windows setting.\n' >&2; return 1 ;;
  esac
}

install_windows
