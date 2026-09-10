#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..60}; do
  while IFS= read -r variable; do
    case "$variable" in
      WAYLAND_DISPLAY=*|DISPLAY=*|HYPRLAND_INSTANCE_SIGNATURE=*|XDG_RUNTIME_DIR=*|XDG_CURRENT_DESKTOP=*) export "$variable" ;;
    esac
  done < <(systemctl --user show-environment)
  display_number=${DISPLAY:-}
  display_number=${display_number#*:}
  display_number=${display_number%%.*}
  if [[ -n "${WAYLAND_DISPLAY:-}" && -S "${XDG_RUNTIME_DIR:-/run/user/$UID}/$WAYLAND_DISPLAY" ]] || [[ -z "${WAYLAND_DISPLAY:-}" && -n "${DISPLAY:-}" && -S "/tmp/.X11-unix/X$display_number" ]]; then
    exec "$HOME/.local/bin/command-space" daemon
  fi
  sleep 0.5
done
printf 'The graphical session did not become ready within 30 seconds.\n' >&2
exit 1
