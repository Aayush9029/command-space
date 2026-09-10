# Contributing

Super Space is built for Omarchy. Useful contributions include launcher fixes, faster search, better keyboard navigation, and Linux support for extension APIs.

For a small fix, open a pull request. For a large feature or architectural change, start an issue describing the problem and proposed behavior so we can discuss the scope first. Report vulnerabilities through [Security](SECURITY.md).

## Get started

Use Rust, Bun, and the Linux dependencies in [Development](docs/DEVELOPMENT.md). Build and test on Linux. From a Mac, `scripts/dev.sh` syncs the checkout to an Omarchy VM and runs the supplied command over SSH.

The launcher starts at `src/linux/main.rs`. Native views and system integration live in `src/linux/`; the TypeScript extension runtime lives in `runtime/`. Bundled extensions are in `extensions/`. [AGENTS.md](AGENTS.md) has the repository map and working conventions.

## Make the change

Keep each pull request focused on one problem. Describe the behavior before and after, especially for keyboard shortcuts, search ranking, and extension compatibility.

Read Omarchy menus and settings from the installed system. Preserve user overrides, nested choices, and existing extension data. Check [Compatibility](docs/PORTING.md) before adding or changing extension APIs.

Use clear names and small, direct functions. Add comments for constraints that the code cannot explain. Keep documentation plain and concise, with no em dashes. Include images only when they explain the product or support a test. Keep license notices for reused code and artwork.

## Check your work

Run the checks in [Development](docs/DEVELOPMENT.md). Add regression tests for bugs and meaningful tests for new behavior. Use temporary files and disposable fixtures for settings, extension storage, and administrative commands.

Rust changes should pass formatting, Clippy, and the Linux tests. Runtime changes should pass the Bun suite; bundled workflow changes have their own tests. Installer or release changes also need the package checks.

Desktop tests can open windows or change the clipboard. Run them deliberately on a test desktop, and say when you have only tested the code headlessly. Documentation-only changes need link and formatting checks.

## Open the pull request

Use a short, descriptive title. Explain the result, the checks you ran, and any remaining limits. Link the relevant issue and include a screenshot when the visual change benefits from one. Avoid unrelated formatting, generated build output, credentials, and large demo assets.
