# Development

Build on Omarchy with Rust, Bun 1.4.2+, Python 3.12+, and the system dependencies listed in [CI](../.github/workflows/ci.yml).

```sh
bun install --cwd runtime --frozen-lockfile --ignore-scripts
bun run --cwd runtime typecheck
bun run --cwd runtime build
cargo build --locked --bin super-space
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
bun run --cwd runtime test
bun test --timeout 60000 extensions/omarchy-tools/tests
bun test scripts/*.test.ts
python3 scripts/test-measure-performance.py
```

From a Mac, prefix each command with `scripts/dev.sh` to sync and run it over SSH. Set `SUPER_SPACE_VM` to your SSH host; it defaults to `omarchy`. Builds stay on the guest's native filesystem.

The strict TypeScript check covers the runtime, browser bridge, bundled extensions, fixtures, and validators. Bun executes TypeScript directly; the browser bridge is bundled to JavaScript with `bun run --cwd runtime build`. Generated browser files are not committed.

## Install

For a prebuilt install on Omarchy, use the one-liner in the [README](../README.md). It verifies the release download, installs missing dependencies, and configures the launcher. Run it as your desktop user with the standard Omarchy XDG directories. Missing system packages may require sudo; Bun is installed in `~/.bun/bin`. Dependency installs remain if application setup fails, while launcher files and integration are restored.

Existing Command Space installations migrate when you run the one-liner. Settings, history, and extensions move to the new directories. If both names already contain data, installation stops so neither is overwritten.

To build and install from this checkout:

```sh
bash scripts/install-linux.sh
```

The installer builds a release binary, replaces Omarchy's launcher bindings, and restarts the user service. Use `--debug` for development or `--prebuilt` from an extracted release archive.

`super-space integration uninstall` removes desktop integration and retains settings and extension data. Hyprland backups live in `~/.local/state/super-space/backups`.

## Package

```sh
bash scripts/package-linux.sh
```

Archives and checksums go in `dist/`. Packaging checks the executable, bundled extensions, installer rollback, and download bootstrap in disposable homes. The scripts named `verify-*` cover individual integrations; desktop checks can open windows or change the clipboard.

The one-line installer verifies `scripts/installer/bootstrap.py` before running it. When that file changes, update its SHA-256 in `scripts/install.sh`.

The Linux entry point is `src/linux/main.rs`. Extension runtime code lives in `runtime/`; bundled commands live in `extensions/`.
