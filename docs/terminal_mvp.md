# Terminal MVP

Karo Terminal is a safe command runner for preview and verification commands. It is not a full PTY terminal.

## Supported capabilities

- Shell profile selector.
- Windows profiles: PowerShell, CMD, Git Bash if installed, WSL if installed.
- Linux/macOS profiles: common shell fallbacks such as bash, zsh, and sh.
- Command input with explicit Run.
- Stop, Clear, and Copy logs.
- stdout/stderr output.
- status: idle, running, success/completed, error, or blocked.
- exit code display when the backend reports one.
- working directory fixed to the selected project root.

Unavailable profiles are shown as disabled rather than hidden as if they did not exist. This keeps the UI honest about what the current machine can run.

## Allowlist

The MVP runner is intentionally narrow. It allows common safe preview and verification commands such as:

- `pnpm dev`
- `pnpm desktop:dev`
- `pnpm desktop:dev:renderer`
- `pnpm preview`
- `npm run dev`
- `npm start`
- `npm run preview`
- `yarn dev`
- `pnpm test`
- `cargo check`
- `cargo test`
- `pwd`
- `dir`
- `ls`
- `git status`
- `pnpm --version`

Commands outside the allowlist are rejected until a stronger approval flow exists.

## Blocked commands

Destructive commands are blocked by policy. Examples:

- `git clean -fdx`
- `rm -rf`
- `del /s`
- `Remove-Item -Recurse -Force`
- disk formatting or disk management commands

The runner should explain that a command was blocked instead of pretending it ran.

## Not implemented

This MVP is not a full interactive terminal or PTY. It does not support interactive prompts, shell state, terminal control sequences, multiplexing, or a fully general command approval model.

## Secret handling

Terminal logs and reports must not include API keys or secret material. Commands run in the selected project root and should not be used to dump environment variables into committed reports.
