# Working on Super Space

Super Space is a native launcher for Omarchy, built with Rust and Iced. Bun runs TypeScript and TSX extensions through a local protocol. The app targets Linux and Hyprland. Read [Development](docs/DEVELOPMENT.md) for setup and [Compatibility](docs/PORTING.md) for extension support.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/linux/main.rs` | CLI entry point and launcher startup |
| `src/linux/app.rs` | Launcher state, messages, navigation, and views |
| `src/linux/catalog.rs` | Search results, built-in commands, and providers |
| `src/linux/ranking.rs`, `files.rs` | Persistent usage ranking and file indexing |
| `src/linux/menu.rs`, `menu/` | Installed Omarchy menus and package workflows |
| `src/linux/extensions.rs`, `extension_view.rs` | Extension sessions and native rendering |
| `src/linux/icons.rs`, `extension_image.rs`, `tray_image.rs` | Icon lookup, image caches, and rendering |
| `src/linux/integration.rs`, `windows.rs` | Desktop bindings and Hyprland operations |
| `src/unit_conversion.rs` | Unit parsing and conversion |
| `runtime/host.ts`, `invocation.ts` | Extension supervisor and command processes |
| `runtime/api.ts`, `renderer.ts` | Extension API surface and React rendering |
| `runtime/icons/` | Local icon catalog, artwork, and attribution |
| `extensions/` | Bundled commands and workflow tests |
| `scripts/` | VM development, installation, packaging, and validation |

Read the relevant modules before editing. Extension exports and catalog entries may be called dynamically; a missing local reference does not prove they are unused. Removed upstream code is available in Git history.

## Work in the VM

Build and test Linux changes through `scripts/dev.sh`. It synchronizes the Mac checkout to `~/Developer/super-space` on the SSH host in `SUPER_SPACE_VM`, defaulting to `omarchy`. Build artifacts stay on the guest's native filesystem.

```sh
scripts/dev.sh cargo fmt --all --check
scripts/dev.sh cargo clippy --locked --all-targets -- -D warnings
scripts/dev.sh cargo test --locked --all-targets
scripts/dev.sh bun run --cwd runtime typecheck
scripts/dev.sh bun run --cwd runtime test
scripts/dev.sh bun test --timeout 60000 extensions/omarchy-tools/tests
```

The sync excludes Git, dependencies, and build output. It does not delete removed source files on the guest. Mirror intentional deletions explicitly before validating removal of modules or assets. Formatting runs in the guest too; copy formatting changes back to the checkout before the next sync.

Use Bun for JavaScript execution, dependency installation, and tests. `node:` imports are Bun compatibility APIs and do not require a Node process. Keep `runtime/bun.lock` frozen during normal installs and disable dependency lifecycle scripts.

## Preserve behavior and data

Load Omarchy menu definitions and user overrides from the installed system. Preserve nested routes, dynamic providers, conditions, checked states, and user extensions. Avoid hard-coded copies of system menus.

Keep search and indexing work off the UI path. Reject stale asynchronous results after a query, route, root, or visibility change. Hidden actions must stay out of normal search and usage ranking while remaining restorable from Hidden Actions.

Preserve user settings, history, extension data, and custom bindings through updates. Test persistence changes with disposable data, including failure paths. Pass filenames and subprocess arguments literally; do not build shell commands from unchecked user input.

Match extension API behavior at the protocol boundary. Preserve command arguments, launch context, callbacks, navigation, and cancellation. Process separation is lifecycle management, not a security sandbox. Do not claim compatibility based on compilation alone.

Keep local icon assets and aliases used by extensions. Check that images render and cache correctly before removing or replacing them. Preserve MIT notices in `LICENSE.md` and `runtime/icons/LICENSE`.

## Test without disrupting the desktop

Use SSH for development. Prefer unit, protocol, and fixture tests on Linux. Run focused checks while iterating, then the relevant full suites before publishing.

Use Safari MCP for real browser interaction. Do not use Chrome-based automation. Native UI interaction needs authorization from the current task. If the user asks for no desktop changes, avoid opening windows, sending keys, changing focus, or modifying the clipboard. Capture screenshots only within the authorized scope.

Some `verify-*` scripts restart the launcher or operate desktop features. Read them first. Use isolated validators and disposable windows or homes when available. A headless test pass does not establish visual correctness.

For installer and packaging changes, run:

```sh
scripts/dev.sh bash scripts/package-linux.sh
```

This validates the archive and real installer in disposable homes. Keep the packaged README screenshot and documentation paths aligned with the validator. Legacy installations migrate through `scripts/migrate-legacy.py`; keep its rollback and data-preservation tests intact.

## Keep the repository clear

Prefer clear names and direct code. Comments should explain non-obvious constraints or architectural decisions. Do not add comments, TODO annotations, or change notes to Markdown or configuration files.

Keep the README brief and consumer-facing. Put contributor instructions in `CONTRIBUTING.md`, security guidance in `SECURITY.md`, and operational detail in the development docs. Use plain language, avoid em dashes, and remove repeated explanations. Add assets only when the product, documentation, or tests use them.

Remove code only after checking build roots, imports, runtime lookup, and tests. Do not commit credentials, private machine details, generated bundles, or temporary validation output. Do not discard unrelated user changes.

## Publish

When asked to add and push changes, use the repository's commit helper:

```sh
source ~/.oh-my-zsh/custom/dotfiles/zsh/ccm.zsh
ccm
git push
```

Do not replace `ccm` with manual staging or commits. Use one conventional commit subject with no body. Use the `aayush/` prefix when creating a branch unless the user supplies another name.

Keep pull request titles descriptive and explanations proportional to the change. State what changed, what passed, and any remaining limitations. Create release tags only when a release is requested; the tag must match the Cargo version. Verify the pushed revision and working tree before reporting completion.
