# Developing Command Space on Omarchy

The Mac checkout is `/Users/yush/Developer/command-space`. The GitHub fork is [Aayush9029/command-space](https://github.com/Aayush9029/command-space), with [MystikoLab/rustcast](https://github.com/MystikoLab/rustcast) retained as `upstream`.

Run `ssh omarchy` or `ssh command-space-vm` from the Mac. Both use `omarchy@127.0.0.1:2222`, a dedicated Ed25519 key in `~/.ssh/id_ed25519_command_space`, strict host-key checking, and a reusable SSH connection. The guest SSH service starts at boot. A full shutdown and launch through Try Omarchy on 2026-09-09 verified that key authentication and the saved port forward survive a cold boot. Try Omarchy saves a TCP forward from Mac port 2222 to guest port 22, bound to localhost.

The verified guest Ed25519 host-key fingerprint is `SHA256:xZl3wrpbhbvDFOyzrtG3xEK2nM9vfvnBHjhWTH/+69M`. Verify a changed host key through the VM console before updating known hosts. Credentials and private keys do not belong in the repository.

Try Omarchy currently shares `/Users/yush/Developer/omarchy` as `/home/omarchy/omarchy` through `/mnt/mac`. Build artifacts use the guest’s native filesystem at `/home/omarchy/Developer/command-space/target` for fast metadata operations. `scripts/dev.sh` synchronizes source changes through SSH and runs a command there, with Rust and mise on PATH.

```
scripts/dev.sh cargo build --bin command-space
scripts/dev.sh cargo test
scripts/dev.sh cargo clippy --all-targets -- -D warnings
```

The guest runs Arch Linux ARM, Hyprland, and Omarchy Quattro. Omarchy’s menu lives in `/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc`, with user overrides in `~/.config/omarchy/extensions/omarchy-menu.jsonc`. Current theme colors live in `~/.local/state/omarchy/current/theme/colors.toml`. Hyprland’s user configuration is Lua in `~/.config/hypr`.

Development commands run through SSH. UI validation uses the visible Try Omarchy desktop. Starting an application through the systemd user manager supplies the existing Wayland, display, and D-Bus environment.

For click testing when Try Omarchy's QEMU window is unavailable to macOS accessibility tools, run `scripts/vm-viewer.py --qmp <current-qmp-socket>`. It serves a loopback-only, capability-protected view of the real guest desktop. Frames come from `grim` over SSH; keyboard and pointer input goes to QEMU. Open the printed address with Safari MCP. The viewer captures on input and on Refresh view instead of continuously. Avoid click tests during a build.

The guest development dependencies include `base-devel`, `pkgconf`, `rsync`, `cmake`, `wayland`, `libxkbcommon`, `libxkbcommon-x11`, `openssl`, `wtype`, and `zenity`, plus Rust, Node.js, and Python 3.12 or newer. The systemd user environment already contains the session's Wayland and D-Bus variables.

Install or update the guest application with `scripts/dev.sh bash scripts/install-linux.sh`. This builds the release profile, installs the runtime and desktop entry, applies the Omarchy bindings, and restarts the user service. For iteration, append `--debug`. The installed service explicitly includes mise and Rust on PATH; desktop-session commands that invoke Node directly should use `/home/omarchy/.local/share/mise/shims/node`.

The installed launcher survived a guest reboot on 2026-09-09: `command-space.service` was active and enabled, the command socket answered `ping`, and Hyprland reported no configuration errors. Its default shortcut was then exercised through the live viewer. A process started by `scripts/install-linux.sh` runs independently of this development session.

`command-space integration uninstall` disables the service and removes its Hyprland override. It retains configuration and extension data. Original Hyprland files are backed up under `~/.local/state/command-space/backups`.

## Validation and packaging

`runtime` contains isolated protocol tests plus opt-in desktop tests. `scripts/verify-menu.mjs` compares the installed menu against Omarchy’s own menu model. `scripts/verify-extensions.mjs` exercises installation, updates, failure cleanup, and removal. `scripts/verify-integration.py` uninstalls and reinstalls desktop integration while checking retained data.

`bash scripts/package-linux.sh` creates an architecture-specific archive and checksum in `dist`. `scripts/verify-updater.mjs` installs that package through a local release fixture, then verifies restoration after a deliberately failed installer. Run it through a separate systemd user unit with an absolute script path, since it restarts the launcher service.

`command-space benchmark` measures catalog loading and in-process search. `scripts/measure-performance.py` measures service restart and warm reopening through the real Hyprland window state, then samples hidden-service CPU and memory after a settling period. Its window timings include polling overhead and do not measure display frame latency. Run desktop measurements through the graphical systemd user environment without concurrent builds or screenshot capture.
