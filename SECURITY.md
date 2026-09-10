# Security

Report vulnerabilities through [GitHub's private reporting form](https://github.com/Aayush9029/super-space/security/advisories/new). Use public issues for ordinary bugs that do not expose users or their data.

## What to include

Describe the affected feature, the impact, and the steps needed to reproduce it. Include your Super Space version or commit, Omarchy version, CPU architecture, and any relevant extension versions. A small reproduction or patch helps.

Remove passwords, tokens, private keys, clipboard contents, and personal file paths from logs and screenshots. If a reproduction needs a secret, use a disposable value. Share exploit details privately while a fix is being prepared.

Check whether the issue occurs on the latest release or current `master` when practical. Say which version you tested; you do not need to upgrade a working system just to report a problem.

## Extensions and local access

Extensions run as your desktop user in Bun. They can access files, the network, and subprocesses available to that user. Separate command processes provide lifecycle cleanup, not a security sandbox. Install extensions and dependencies you trust.

Dependency installation disables package lifecycle scripts. Extension code still executes when launched. Administrative workflows use Omarchy's authentication flow; the launcher should not collect or store your administrator password.

Clipboard history, search history, extension storage, and browser access can contain sensitive information. Treat copies of application data as private. Prompts sent through the AI API go to the endpoint configured in Settings.

## Updates and fixes

The updater checks release archives against their published SHA-256 checksums and validates the package before installation. Checksums detect a mismatch; they do not provide an independent signature if the publishing account is compromised.

Security changes should include a regression test with disposable data. Reports involving another project's extension may need coordination with its maintainer. Acknowledgment, fix timing, and public disclosure are arranged through the private report; there is no guaranteed response deadline.
