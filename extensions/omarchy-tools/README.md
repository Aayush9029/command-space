# Omarchy Tools

Native forms and lists for Omarchy operations that otherwise collect input through a terminal, file chooser, or shell menu. Commands use the installed Omarchy scripts with complete arguments and retain their existing desktop integration.

The extension includes web app and TUI installation, reminders, media conversion, LocalSend sharing, branding images and text, wallpapers, theme installation, shell plugins, RetroArch launchers, custom DNS, SSH access, Windows VM configuration, and drive passphrase changes. Available RetroArch cores, encrypted drives, and shell plugin metadata come from the installed system.

Cancel stops a form operation and its subprocesses. Closing the extension also stops an operation that has not been handed to an authentication terminal. SSH setup, Windows installation, and drive passphrase changes collect settings in the launcher, then use the terminal for administrator authentication and progress. New passwords travel in private, one-use data files and stdin, never command-line arguments. The current drive passphrase stays in cryptsetup's terminal prompt.

Validation keeps invalid desktop entries from being written, preserves existing media outputs and wallpapers, and confirms replacement of existing application launchers. Theme installation requires a new theme name because the stock installer removes an existing theme before cloning its replacement. The Windows adapter reuses the installed installer and replaces its known configuration prompts with native form values; unfamiliar prompts fail explicitly.

Run tests inside Omarchy after installing the runtime dependencies:

```sh
node --test extensions/omarchy-tools/tests/*.test.mjs
```

The tests exercise the TypeScript forms through the extension host, validate subprocess arguments and cancellation, and run the original web app, TUI, and transcode scripts in disposable homes. The original-script test is skipped outside Omarchy.
