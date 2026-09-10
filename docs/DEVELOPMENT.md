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

The guest runs Arch Linux ARM, Hyprland, and Omarchy Quattro. Omarchy’s menu lives in `/usr/share/omarchy/default/omarchy/omarchy-menu.jsonc`, with user overrides in `~/.config/omarchy/extensions/omarchy-menu.jsonc`. Current theme colors live in `~/.local/state/omarchy/current/theme/colors.toml`. The launcher defaults to a dark charcoal palette and Adwaita Sans; selecting the Omarchy theme in settings reads those system colors. Hyprland’s user configuration is Lua in `~/.config/hypr`.

Development commands run through SSH. UI validation uses the visible Try Omarchy desktop. Starting an application through the systemd user manager supplies the existing Wayland, display, and D-Bus environment.

For click testing when Try Omarchy's QEMU window is unavailable to macOS accessibility tools, run `scripts/vm-viewer.py --qmp <current-qmp-socket>`. It serves a loopback-only, capability-protected view of the real guest desktop. Frames come from `grim` over SSH; keyboard and pointer input goes to QEMU. Open the printed address with Safari MCP. The viewer captures on input and on Refresh view instead of continuously. Avoid click tests during a build.

The guest development dependencies include `base-devel`, `pkgconf`, `rsync`, `cmake`, `wayland`, `libxkbcommon`, `libxkbcommon-x11`, `openssl`, `wtype`, `zenity`, and `util-linux`, plus Rust, Node.js 24 or newer, npm, and Python 3.12 or newer. The updater uses `flock` from `util-linux` to serialize installations. The installer discovers mise, user, and Rust executables before checking dependencies, the user service manager, and Omarchy configuration; failed preflight leaves the installation unchanged. The systemd user environment already contains the session's Wayland and D-Bus variables.

Install or update the guest application with `scripts/dev.sh bash scripts/install-linux.sh`. This builds the release profile, installs the runtime and desktop entry, applies the Omarchy bindings, and restarts the user service. For iteration, append `--debug`. The installed service explicitly includes mise and Rust on PATH; desktop-session commands that invoke Node directly should use `/home/omarchy/.local/share/mise/shims/node`.

The installed launcher survived a guest reboot on 2026-09-09: `command-space.service` was active and enabled, the command socket answered `ping`, and Hyprland reported no configuration errors. Its default shortcut was then exercised through the live viewer. A process started by `scripts/install-linux.sh` runs independently of this development session.

`command-space integration uninstall` disables the service and removes its Hyprland override. It retains configuration and extension data. Original Hyprland files are backed up under `~/.local/state/command-space/backups`.

## Validation and packaging

`runtime` contains isolated protocol tests plus opt-in desktop tests. Its supervisor lives in `runtime/host.mjs`; each command executes in a fresh `runtime/invocation.mjs` process. Lifecycle tests cover repeated launches, stale callbacks, timer and child-process cleanup, and background refresh behavior.

Run the bundled native workflow suite with `node --test extensions/omarchy-tools/tests/*.test.mjs`. It covers TypeScript forms, subprocess arguments and cancellation, and original Omarchy scripts in disposable homes. Administrative workflow tests record system changes instead of altering live network, SSH, VM, or encryption configuration.

`scripts/verify-menu.mjs` compares the installed menu against Omarchy’s own menu model. `scripts/verify-native-menu.mjs` checks native provider rows against installed packages, themes, plugins, bindings, and other system sources without executing mutation actions. `scripts/verify-extensions.mjs` exercises installation, updates, failure cleanup, and removal. `scripts/verify-integration.py` uninstalls and reinstalls desktop integration while checking retained data and browser bridge registration.

`scripts/fixtures/native-validation` contains commands for native form focus, masked grid images, list/grid pagination, browser access, launch context, and tray interactions. Install it only for validation and use the visible guest UI for clicks and keyboard input.

`scripts/verify-window-management.mjs` exercises window geometry and state against a disposable terminal with class `command-space-window-validation` on a workspace numbered 9900 or higher. Supply its ID through `COMMAND_SPACE_WINDOW_TEST_ID` and the optimized executable through `COMMAND_SPACE_BINARY`. The harness rejects ordinary application windows. Visible pin and tile checks require `COMMAND_SPACE_WINDOW_VISIBLE_TEST=1`; display routing requires a temporary second output. Geometry assertions allow one logical pixel of compositor rounding, and applications may enforce minimum sizes.

For destructive clipboard UI checks, `python3 scripts/verify-clipboard-clear.py prepare` starts a launcher with disposable history. Exercise Cancel and then Confirm through the UI, then run the script with `finish` to verify clearing and restore the normal service. Its `restore` command also restores the normal service after an interrupted test. The fixture checks that the real history and configuration remain unchanged.

`bash scripts/package-linux.sh` creates an architecture-specific archive and checksum in `dist`, including the runtime, bundled commands, and documentation. It runs `scripts/verify-linux-package.mjs` to check extraction, the executable, bundled compilation, and an isolated launch of the extracted TypeScript host. It also runs `scripts/verify-installer.mjs`, which executes the actual installer and Rust binary in a disposable home with recorded systemd commands and a private command socket. That regression exercises restricted SSH PATH, mise-only Node discovery, desktop and browser registration, bundled updates, and dependency failures that must leave existing files unchanged.

`node scripts/verify-updater-isolated.mjs <archive>` checks download, installation, and rollback using disposable XDG directories and a fixture installer. The release workflow runs it for each architecture. It does not restart the desktop launcher.

`scripts/verify-updater.mjs` installs the actual package through a local release fixture, then verifies restoration after a deliberately failed installer. Run it through a separate systemd user unit with an absolute script path, since it restarts the live launcher service.

`command-space benchmark` measures catalog loading and in-process search. `scripts/measure-performance.py` measures service restart and warm reopening through the real Hyprland window state, then samples hidden-service CPU and memory after a settling period. Its window timings include polling overhead and do not measure display frame latency. Run desktop measurements through the graphical systemd user environment without concurrent builds or screenshot capture.

`cargo test --locked --bin command-space` exercises frecency decay and persistence, legacy-history migration, concurrent ranking writers, file-index reconciliation and persistence, fuzzy paths, exclusions, root changes, and stale query rejection using disposable fixtures. It does not open applications or change the desktop. `cargo test --release --locked --bin command-space files::tests::cached_search_ten_thousand_files -- --ignored --nocapture` measures cold indexing, cached loading, and in-memory queries using a temporary 10,000-file tree.

`cargo test --release --locked aur_catalog_search_profile -- --ignored --nocapture` measures search against the guest’s installed AUR catalog. It requires the full catalog and excludes provider loading from its query timings.

Both hosted CI architectures and package builds passed at `edc243c`. The release workflow repeats the full checks for each tagged revision. Native test results and release validation are tracked in [PORTING.md](PORTING.md).
