# Compatibility

Command Space targets Omarchy with Hyprland. It reads the installed menu and user overrides, including nested routes, conditions, checked states, and dynamic choices. Package and administrative operations use Omarchy's installed scripts and authentication flow.

TypeScript and TSX extensions run in Bun. The runtime supports native lists, grids, forms, details, action panels, background commands, storage, clipboard, OAuth, and configurable AI endpoints. Chromium and Firefox use the included browser bridge. Each command launch gets a fresh process; detached services remain the extension's responsibility.

Base64, UUID Generator, Lorem Ipsum, JSON Format, and Days Until Christmas have been tested from the Raycast extension repository. Other extensions depend on the APIs and external programs they use. macOS frameworks and AppleScript need Linux replacements; compiling an extension does not establish compatibility.

Window commands use Hyprland. Applications can enforce minimum sizes. Administrative workflow tests use disposable fixtures instead of changing live DNS, SSH, virtual machines, or encrypted drives.

See [Development](DEVELOPMENT.md) for builds and tests.
