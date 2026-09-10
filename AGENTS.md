# Command Space

Build and test on Omarchy through `scripts/dev.sh`. It syncs this checkout to the VM.

Use SSH for development and Safari MCP for browser interaction. Use native UI controls only when authorized.

Keep names clear and comments limited to non-obvious constraints. Do not add comments or TODOs to docs or config.

Load Omarchy menus from the installed system. Preserve nested routes, providers, conditions, checked states, and user extensions. Keep MIT attribution in LICENSE.md.

The launcher starts at `src/linux/main.rs`. Unit conversion lives in `src/unit_conversion.rs`.

To publish, source `~/.oh-my-zsh/custom/dotfiles/zsh/ccm.zsh`, run `ccm`, then `git push`.
