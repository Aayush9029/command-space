# Command Space

Build and test Linux changes inside the Omarchy VM using `scripts/dev.sh`.
The Mac checkout is synchronized to the guest’s native filesystem for builds.

Prefer clear names and self-explanatory code. Add comments only for non-obvious constraints or architectural decisions. Do not add comments, TODO annotations, or change notes to documentation or configuration files.

Use Safari MCP for real browser interaction. Use SSH for guest development and native UI controls for interaction testing.

When asked to add and push changes, source `~/.oh-my-zsh/custom/dotfiles/zsh/ccm.zsh`, run `ccm`, then `git push`.

Preserve Omarchy menu definitions, user extensions, nested routes, dynamic providers, conditions, and checked states. Load these from the installed system rather than duplicating the menu. Keep MIT attribution from RustCast.

The Linux launcher is `src/linux/main.rs`. The upstream macOS sources remain available for feature parity work. The shared unit conversion implementation is `src/unit_conversion.rs`.
