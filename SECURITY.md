# Security Policy

Karo is currently an MVP checkpoint. Please treat the desktop runtime, command runner, and model-provider integrations as security-sensitive code.

## Supported Version

Only the current `main` branch / active MVP branch is supported during early development.

## Reporting

Do not open a public issue with secrets, API keys, exploit payloads, or private project data. Report security issues privately to the maintainers.

Include:

- affected area;
- reproduction steps;
- expected vs actual behavior;
- whether command execution, file writes, provider calls, or secret storage are involved.

## Security Invariants

- API keys must not be printed, written to reports, screenshots, logs, or fixtures.
- `.env*` files are ignored and must not be committed.
- Generated GUI reports and screenshots are ignored.
- Agent changes must be staged before Apply Changes writes to the real project.
- Dangerous commands such as `git clean -fdx`, recursive deletes, disk formatting, and forceful removal commands must not run automatically.
- Terminal/Preview commands must pass through Command Policy and the MVP allowlist.
- Read-only project explain/security review must not create artifacts.

## Current Limitations

- Native WebView2 click automation is not implemented.
- The integrated terminal is an MVP safe runner, not a full shell/PTY.
- Preview opens detected URLs externally; embedded preview is not implemented.

