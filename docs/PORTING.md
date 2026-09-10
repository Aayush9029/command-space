# Command Space port

Command Space forks [MystikoLab/rustcast](https://github.com/MystikoLab/rustcast) at `255c02cc1425ea85cf049939673d216c70842faf`. The Linux entry point is `src/linux/main.rs`. The upstream macOS sources remain available for feature comparisons. The Linux binary uses Iced 0.14 and Wayland. Its default presentation is opaque charcoal with Adwaita Sans, restrained separators, compact rows, and a minimal action footer. Settings can follow the active Omarchy theme or apply custom colors.

## Desktop integration

The launcher reads the installed Omarchy Quattro menu and user overrides. It keeps nested menu IDs, aliases, shell actions, conditional visibility, checked states, and font and power-profile providers. Application discovery follows XDG desktop entries. The installed user service starts with the graphical session; reboot, socket health, and shortcut checks have passed. Super+Space and Omarchy’s nested menu shortcuts open Command Space. Clipboard and emoji shortcuts open the native views. The original user configuration is backed up, and `command-space integration uninstall` removes the integration while retaining settings and extension data.

Native providers keep the selection step inside Command Space for packages, AUR packages, installed-package removal, themes, backgrounds, unlock styles, timezones, Omarchy plugins, keybindings, application removal, Docker database choices, and webcams. Their rows are loaded from the installed system. Package transactions use the existing terminal and authentication flow after selection.

The bundled `omarchy-tools` extension supplies twenty-four commands for web app and TUI installation, reminder creation/listing/clearing, media conversion, file and folder sharing, branding images and text, wallpapers, themes, shell plugins, retro game launchers, DNS, SSH, Windows VM setup, encrypted-drive passwords, and precise window movement and resizing. Together with the two developer tools, the release includes twenty-six bundled commands. Forms validate input before calling the installed Omarchy scripts or desktop APIs. Long operations expose cancellation; closing their view stops the operation and its subprocesses. Privileged setup still uses the terminal for administrator authentication, existing drive passwords, and progress. New passwords pass through private, single-use files and standard input instead of command-line arguments.

Workflow tests exercise the real React host, argument handling, and cancellation. Original web app, TUI, and media scripts ran in disposable homes with the old pickers replaced by failing sentinels. The stock SSH setup and Windows installation function were exercised with system changes replaced by recorded test commands. This establishes host and script integration without making live DNS, SSH, VM, or encryption changes.

The development workflow and SSH configuration are documented in [DEVELOPMENT.md](DEVELOPMENT.md). Rust builds run with a lower scheduling priority so desktop interaction and SSH remain responsive.

## Extension runtime

TypeScript and TSX commands are bundled with esbuild. A lightweight Node.js supervisor starts a fresh invocation process for each command launch. A React reconciler serializes native UI trees to the Rust launcher; callbacks travel back to the invocation process. Each extension has its own persistent storage directory.

Persistent storage mutations use an advisory file lock across foreground and background processes. Concurrent-writer tests preserve independent storage keys and cache namespaces; terminating a writer releases its lock, and serialization failures leave the previous file intact.

Invocation isolation prevents module state, timers, and ordinary child processes from leaking between launches. Finishing a no-view command terminates its invocation process group before reporting completion. Ending a view command cleans up its invocation as well. Menu-bar invocations retain React callbacks until refreshed; a scheduled tick can replace a hung background invocation and coalesces queued refreshes. Callback and request identifiers include the invocation generation, so obsolete responses are ignored. These lifecycle paths have passed the isolated runtime suite and the installed external-extension suite.

Applications opened through desktop APIs and deliberately detached external workloads remain independent. Extensions that deliberately launch detached services must manage those services themselves.

Implemented surfaces include lists, sections, action panels, navigation, markdown details, list detail panes, dropdown filters, loading states, forms, multiline fields, checkboxes, tags, file pickers, preferences, command arguments, alerts, clipboard operations, local storage, and caches. Date picker submissions preserve JavaScript Date values. Grids use filtered results, section-specific columns, and keyboard selection; action shortcuts map Raycast’s Command modifier to Control. List and grid pagination requests load further pages without duplicating an in-flight request. Native keyboard tests reached the third page in both layouts. Empty-state action panels are supported.

Form references support focus and reset, and navigation keeps previous React screens mounted. Form values can persist across independent launches. Native fields reject stale React updates while preserving newer input. Searchable action panels retain nested submenus. Date fields also offer a calendar dialog. Native keyboard tests cover focus and blur events, refs, Tab and Shift+Tab traversal, scrolling to focused fields, checkbox and tag toggling, dropdown selection, and submission from non-text controls. Remembered fields persist only after an accepted submission.

The icon catalog covers 478 official Raycast names and thirteen aliases with 464 bundled SVG assets. The artwork uses attributed MIT-licensed Phosphor equivalents and composed symbols. Local image handles are bounded and cached, with invalidation when files change; remote images reuse a disk cache. Supported raster formats include PNG, JPEG, WebP, GIF first frames, ICO, and BMP. It resolves API names, legacy `icon:Name` strings, and raw icon values. Remote extension images are cached on disk, with coverage for downloads, custom request headers, reuse, embedded data images, and fallbacks. Native grid checks verified masked raster images, SVGs, color tinting, emoji, and selection across sections. Thumbnails respect the available cell width.

Raycast's platform labels describe its available hosts, so those labels alone do not exclude an extension. Actual calls to unsupported macOS APIs fail explicitly. Cross-platform extensions must be tested against the APIs they use; successful TypeScript compilation alone does not establish compatibility.

The independent `scripts/verify-menu.mjs` check uses Omarchy’s installed JavaScript menu model as its reference and compares the complete set of definitions and routes, including actions, aliases, conditional rows, checked labels, and custom icon fonts. `scripts/verify-native-menu.mjs` separately compares native provider rows against the running system without executing mutation actions. Click tests also cover nested Install and Style navigation.

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

The settings UI edits common behavior, color overrides, placement, shortcuts, search folders, aliases, shell commands, and custom modes. Shell aliases accept quoted positional arguments. Configuration changes reload while the launcher is running. Native settings tests cover field editing and saving, Tab navigation, dropdown changes, checkbox activation, and scrolling focused controls into view. The AI endpoint field preserves the URL during typing. A disposable API key was entered through the native password dialog, verified in the real desktop keyring, and removed through settings; cancelling the remaining draft preserved the configuration.

The launcher fits its monitor’s usable area, including fractional scaling, and supports nine placement positions. It explicitly raises its Hyprland window after opening or refocusing, including when the previous application is floating. Window management provides sixty-five direct commands, including thirty geometry presets, plus forms for precise movement and resizing. Native checks cover every preset, relative movement and sizing, state restoration, workspaces, scratchpads, pinning, tile movement, partial bounds, fullscreen, and maximized states. Next and previous display commands passed against a temporary scaled display, and unavailable-display errors passed on a single-display setup. Operations preserve focus and target the window focused before the launcher opened. Mouse-submitted Move Window and Resize Window forms moved a disposable terminal to X=200, Y=100 and resized it to 777×555, preserving omitted bounds. Restore Window returned it to its original tiled state. Geometry comparisons allow one logical pixel for compositor rounding; applications can also enforce their own minimum sizes.

Clipboard history uses Omarchy’s persistent capture service. Text and image previews, explicit copy and paste, item deletion, and confirmed clearing are available. Native Clear History tests first cancelled and then confirmed the action against isolated fixture history; the original history and settings were unchanged. The native Paste action produced exact expected text in a disposable terminal.

Native file tests previewed a disposable text file, copied its exact path, revealed it in the file manager, and confirmed moving it to Trash. The file content was verified in the trash directory. Emoji results use a keyboard-navigable grid.

Native package tests selected `jq`, changed the search to `curl`, and used Tab to select another package while retaining the earlier choice. The action footer showed both selected packages. The optimized launcher displayed structured metadata for `jq` and `rustdesk-bin`; the Actions menu opened the actual AUR PKGBUILD as monospace text. Immediate package search after a cold service restart remained populated once the provider loaded. Ctrl+Shift+P toggled the metadata pane, and Ctrl+Shift+B opened the AUR build script without changing the query. Cancelling package removal left the installed `jq` version unchanged. No package transaction was executed during these checks.

On the development ARM64 VM, the published 1.0.0 package measured 52.36 ms from service restart to a mapped window and 16.30 ms median / 21.06 ms p95 for twenty warm opens. After settling, the hidden service used 55.71 MiB and 0.097% of one CPU core, including the Days Until Christmas background worker. These measurements use IPC and Hyprland window-state polling; they do not measure display frame latency.

An optimized five-query profile searched 119,141 AUR entries in 1.49–4.30 milliseconds per query. These measurements cover search after the provider has loaded, excluding catalog loading and display rendering.

Extension management supports source folders and GitHub repository/folder URLs, dependency installation, saved update sources, replacing installations with rollback on failure, and uninstalling while preserving extension data. Installation from GitHub has passed a native UI test with JSON Format. Local update, removal, duplicate installation, failed dependency installation rollback, symlink rejection, and staging cleanup pass the lifecycle verification script. GitHub source updates also pass.

Automated checks cover the Rust launcher, isolated extension protocol, bundled Omarchy workflows, installed external extensions, Linux desktop clipboard/application/window APIs, and independent Omarchy menu comparisons. Clippy is run with warnings denied.

OAuth requests use S256 PKCE and validate state before accepting a callback. Tokens round-trip through the real desktop keyring. Browser-launch failures cancel the pending request. AI requests support streaming SSE, configured model mappings, and abort signals; a local HTTP fixture verifies these without calling a paid provider.

The Linux window API reads desktops and window bounds and moves or resizes windows through Hyprland. It has been tested against a disposable terminal. The launcher now registers a StatusNotifierItem tray with open, clipboard, extensions, settings, refresh, and quit commands.

## Background and browser extensions

Menu-bar extensions retain their own Node worker and React state while the launcher is closed. Activation is stored privately and restored at login. Manifest intervals refresh commands; source updates reload active commands. Native StatusNotifierItem menus support sections, nested actions, keyboard shortcut labels, confirmations, preferences, refresh, and stopping a command. Glyphs, color emoji, and raster icons render in the tray. `launchCommand` carries arguments, launch type, and launch context between workers.

Native click tests exercised counter state, nested tray actions, confirmation dialogs, nested action panels, and calendar submission. A September 17 date arrived as a JavaScript Date alongside the form’s text and checkbox values. Two successive guest reboot tests verified the launcher shortcut and all three expected trays. The tray service now waits for the desktop watcher if startup ordering brings the launcher up first.

The included browser bridge uses native messaging and a private Unix socket. It implements tab listing and page extraction in text, HTML, and Markdown. Browser capability detection reports whether a live connection exists. The installer preserves Omarchy’s existing Chromium extensions and adds the bridge. A disposable Chromium profile was clicked through the Safari VM viewer: the native validation command found the fixture tab and displayed its Markdown, while exact text and HTML assertions passed, including accented text and emoji. Reconnecting after a browser restart also passed. The packaged Firefox variant passed tab discovery and exact Unicode text, HTML, and Markdown checks in Firefox 155.0.1. It reconnected after its native helper was terminated and returned identical content. Its disposable profile was removed without changing browser defaults.

Clipboard APIs offer simultaneous text/HTML alternatives and file URIs. Confidential copies set the MIME hint honored by Omarchy’s clipboard capture service; a real desktop test verifies that the fixture is excluded from history. Application APIs resolve default handlers for the requested file or URL type.

## Installation and updates

Uninstall/reinstall verification restores Omarchy’s bar and shortcut configuration while preserving settings, extension installations, and storage. The installer discovers mise and user tools and validates Node.js 24 or newer, Python 3.12 or newer, required commands, the user service manager, and the Omarchy configuration before modifying installed files. It waits for the command socket before reporting success. SSH authentication and the launcher service both survive a guest reboot. The final installed launcher was verified after a fresh boot: the service was enabled and active, the socket responded, Hyprland had no configuration errors, and both Super+Space and the bar button opened the native UI. The launcher tray and retained menu-bar extension returned automatically.

Linux packaging includes the native executable and extension runtime. Release metadata selects the current architecture, requires a matching SHA-256 checksum, rejects links and unsafe archive paths, and verifies the executable version before installation. Updates run in a separate user unit so restarting the launcher cannot terminate its installer. An end-to-end fixture installed the valid ARM64 package, then deliberately replaced the binary and runtime with broken files and failed. The updater restored the exact previous files, restarted the service, and preserved settings.

The current ARM64 package passes extraction, executable, bundled-command compilation, and extracted TypeScript host checks. Its actual installer and Rust binary also pass a restricted-PATH regression in a disposable home, with Node available only through mise. The test verifies desktop and browser registration and persistent bundled-extension sources while recording systemd operations and providing an isolated command socket. Missing Node, Node 22, and missing rsync fail without changing the existing binary, runtime, or configuration. The same regression reproduces the original missing-Node failure against the earlier installer.

An isolated updater test covers download, checksum validation, installation, and rollback of the binary, runtime, and bundled extension files while preserving user extensions and stored data. Advisory-lock tests cover concurrent attempts and owner crashes. These tests supplement the live service installation checks.

The GitHub workflows target Linux ARM64 and x86-64. Both architectures passed [CI](https://github.com/Aayush9029/command-space/actions/runs/34431732614) and [package verification](https://github.com/Aayush9029/command-space/actions/runs/34431732627) at `edc243c`. The hosted ARM64 archive also passed executable, extracted TypeScript host, and isolated installation checks on Omarchy. The release workflow repeats these checks for each tagged revision before publishing its artifacts.

## Compatibility scope

The native Omarchy menu, package views, administrative forms, and window commands have passed the checks above. Administrative forms have host and original-script integration coverage; live DNS, SSH reconfiguration, Windows VM installation, and encrypted-drive changes were not executed as validation actions.

The Chromium and Firefox bridges have passed native integration checks. Compatibility with an arbitrary extension depends on its APIs, external programs, and service requirements. The verified examples establish those specific integrations; they do not establish universal Raycast extension support. macOS frameworks and AppleScript require platform-specific replacements.
