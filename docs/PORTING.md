# Command Space port

Command Space forks [MystikoLab/rustcast](https://github.com/MystikoLab/rustcast) at `255c02cc1425ea85cf049939673d216c70842faf`. The Linux entry point is `src/linux/main.rs`. The upstream macOS sources remain available for feature comparisons, while the Linux binary uses Iced 0.14, Wayland, and the active Omarchy theme.

## Desktop integration

The launcher reads the installed Omarchy Quattro menu and user overrides. It keeps nested menu IDs, aliases, shell actions, conditional visibility, checked states, and font and power-profile providers. Application discovery follows XDG desktop entries. The installed user service starts with the graphical session; reboot, socket health, and shortcut checks have passed. Super+Space and Omarchy’s nested menu shortcuts open Command Space. Clipboard and emoji shortcuts open the native views. The original user configuration is backed up, and `command-space integration uninstall` removes the integration while retaining settings and extension data.

The development workflow and SSH configuration are documented in [DEVELOPMENT.md](DEVELOPMENT.md). Rust builds run with a lower scheduling priority so desktop interaction and SSH remain responsive.

## Extension runtime

TypeScript and TSX commands are bundled with esbuild and executed in a separate Node.js process. A React reconciler serializes native UI trees to the Rust launcher. Callbacks travel back to the worker without moving extension code into the UI process. Each active extension has its own persistent storage directory.

Implemented surfaces include lists, sections, action panels, navigation, markdown details, list detail panes, dropdown filters, loading states, forms, multiline fields, checkboxes, tags, file pickers, preferences, command arguments, alerts, clipboard operations, local storage, and caches. Date picker submissions preserve JavaScript Date values. Grids now use filtered results and keyboard selection; action shortcuts map Raycast’s Command modifier to Control. Form references support focus and reset, and navigation keeps previous React screens mounted. Remote extension images are cached on disk, with coverage for downloads, custom request headers, and reuse. Form values can persist across independent launches. Native fields reject stale React updates while preserving newer input. Searchable action panels retain nested submenus. Date fields also offer a calendar dialog. Native keyboard tests cover focus and blur events, refs, Tab and Shift+Tab traversal, scrolling to focused fields, checkbox and tag toggling, dropdown selection, and submission from non-text controls. Remembered fields persist only after an accepted submission.

Raycast's platform labels describe its available hosts, so those labels alone do not exclude an extension. Actual calls to unsupported macOS APIs fail explicitly. Cross-platform extensions must be tested against the APIs they use; successful TypeScript compilation alone does not establish compatibility.

The independent `scripts/verify-menu.mjs` check uses Omarchy’s installed JavaScript menu model as its reference. It currently matches all 320 definitions and 321 routes, including actions, aliases, conditional rows, checked labels, and custom icon fonts. Click tests also cover Install → Style navigation.

## Verified external extensions

Unmodified sources from [raycast/extensions](https://github.com/raycast/extensions) are installed in the development VM. Source downloads are held outside the tracked source tree in `.local/compatibility` on the Mac and `~/Developer/compatibility` in the guest.

| Extension | Source tree | Verified behavior |
| --- | --- | --- |
| Base64 | `cbece190a692588381a700779e90f528580dc6f1` | React rendering with `@raycast/utils`, clipboard input, copy action |
| UUID Generator | `3a6a6008939739c9eb96f5b3e89d6923c404ca3a` | Multiple UUIDs from launch arguments, persistent history view, Format UUID through a native argument form and click |
| Lorem Ipsum | `5e0c9a5cd62da702349674b054a82d28b65802f5` | Exact requested word count |
| JSON Format | GitHub folder install from `main` | Native UI installation, rapid form input, formatted detail navigation, clipboard output, and source update |
| Days Until Christmas | `ed51c7f3a2e6b944744592c09cc997dff0397ba6` | Unmodified menu-bar command, native emoji tray icon, title, scheduled activation, and restoration at login |

Run `npm test` in `runtime` for isolated protocol tests. The installed-extension suite additionally requires a desktop session and `COMMAND_SPACE_TEST_EXTENSIONS` pointing to the installation directory. These tests write known test data to the guest clipboard and extension history.

## Native features verified

The settings UI edits common behavior, color overrides, placement, shortcuts, search folders, aliases, shell commands, and custom modes. Shell aliases accept quoted positional arguments. Configuration changes reload while the launcher is running. Settings save has been tested by clicking the native fields and Save button.

The launcher fits its monitor’s usable area, including fractional scaling, and supports nine placement positions. All twelve tiling operations have been checked against a disposable terminal window in Hyprland: halves, quarters, thirds, and maximize. Operations target the window focused before the launcher opened.

Clipboard history uses Omarchy’s persistent capture service. Text and image previews, explicit copy and paste, item deletion, and confirmed clearing are available. File results have preview, reveal, copy-path, and trash actions. Emoji results use a keyboard-navigable grid.

Extension management supports source folders and GitHub repository/folder URLs, dependency installation, saved update sources, replacing installations with rollback on failure, and uninstalling while preserving extension data. Installation from GitHub has passed a native UI test with JSON Format. Local update, removal, duplicate installation, failed dependency installation rollback, symlink rejection, and staging cleanup pass the lifecycle verification script. GitHub source updates also pass.

Current automated checks cover twenty Rust tests, twenty-five isolated runtime tests, five external extension tests, Linux desktop clipboard/application/window API tests, and the independent full Omarchy menu comparison. The native clipboard Paste action was clicked and its exact output verified in a disposable terminal. Clippy passes with warnings denied.

OAuth requests use S256 PKCE and validate state before accepting a callback. Tokens round-trip through the real desktop keyring. Browser-launch failures cancel the pending request. AI requests support streaming SSE, configured model mappings, and abort signals; a local HTTP fixture verifies these without calling a paid provider.

The Linux window API reads desktops and window bounds and moves or resizes windows through Hyprland. It has been tested against a disposable terminal. The launcher now registers a StatusNotifierItem tray with open, clipboard, extensions, settings, refresh, and quit commands.

## Background and browser extensions

Menu-bar extensions retain their own Node worker and React state while the launcher is closed. Activation is stored privately and restored at login. Manifest intervals refresh commands; source updates reload active commands. Native StatusNotifierItem menus support sections, nested actions, keyboard shortcut labels, confirmations, preferences, refresh, and stopping a command. Glyphs, color emoji, and raster icons render in the tray. `launchCommand` carries arguments, launch type, and launch context between workers.

Native click tests exercised counter state, nested tray actions, confirmation dialogs, nested action panels, and calendar submission. A September 17 date arrived as a JavaScript Date alongside the form’s text and checkbox values. Two successive guest reboot tests verified the launcher shortcut and all three expected trays. The tray service now waits for the desktop watcher if startup ordering brings the launcher up first.

The included browser bridge uses native messaging and a private Unix socket. It implements tab listing and page extraction in text, HTML, and Markdown. Browser capability detection reports whether a live connection exists. The installer preserves Omarchy’s existing Chromium extensions and adds the bridge. A disposable Chromium profile was clicked through the Safari VM viewer: the native validation command found the fixture tab and displayed its Markdown, while exact text and HTML assertions passed, including accented text and emoji. Reconnecting after a browser restart also passed. Firefox packaging and native messaging registration exist but have not been exercised in the guest.

Clipboard APIs offer simultaneous text/HTML alternatives and file URIs. Confidential copies set the MIME hint honored by Omarchy’s clipboard capture service; a real desktop test verifies that the fixture is excluded from history. Application APIs resolve default handlers for the requested file or URL type.

## Installation and updates

Uninstall/reinstall verification restores Omarchy’s bar and shortcut configuration while preserving settings, extension installations, and storage. The installer waits for the command socket before reporting success. SSH authentication and the launcher service both survive a guest reboot.

Linux packaging includes the native executable and extension runtime. Release metadata selects the current architecture, requires a matching SHA-256 checksum, rejects links and unsafe archive paths, and verifies the executable version before installation. Updates run in a separate user unit so restarting the launcher cannot terminate its installer. An end-to-end fixture installed the valid ARM64 package, then deliberately replaced the binary and runtime with broken files and failed. The updater restored the exact previous files, restarted the service, and preserved settings.

The GitHub workflows now target Linux ARM64 and x86-64. The ARM64 package was built and installed locally; hosted CI and x86-64 packaging still need to run. No release is published yet.

## Remaining work

The port is in progress. Remaining work includes native grid/image, file and settings checks, final performance measurements, hosted build validation, and publishing the completed fork. Development UI checks use the debug profile; the final installation and performance checks use the optimized release profile. Browser and background extension support and the updater have passed their current integration tests; broad compatibility still depends on each extension’s APIs and external programs.
