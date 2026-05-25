# Preview MVP

Karo Preview is an honest local preview layer for reviewable changes. It does not silently run commands and it does not claim to provide an embedded browser.

## Supported states

| State | Meaning | User action |
|---|---|---|
| `unavailable` | No static file or runnable command was detected. | Use Agent to create runnable files or select a project with scripts. |
| `staged-only/apply-required` | A staged artifact includes `index.html`, but it is not applied to the project yet. | Review Changes, then use Apply Changes before opening from disk. |
| `static-file-ready` | An applied `index.html` exists inside the selected project. | Open it with the OS browser/default handler or copy the project-relative path. |
| `dev-command-available` | `package.json` scripts suggest a dev/preview/start command. | Click Run preview explicitly if the command is allowed by policy. |
| `running` | A preview command is running through the MVP terminal runner. | Watch terminal output for a localhost URL, then open it externally. |
| `error` | Opening or running preview failed. | Read the visible error and terminal logs. |

## Static file flow

For generated static sites, Karo looks for staged/applied `index.html` artifacts. If the file is still staged, Preview shows "Apply changes before preview" and keeps Open preview disabled. After Apply Changes succeeds, Preview can ask the Tauri backend to open the applied HTML file. The backend only opens `.html` or `.htm` files inside the selected project root.

## Dev command flow

If a project has a `package.json`, Karo detects common scripts such as `dev`, `preview`, and `start`. The command is shown before it runs. Karo never starts a dev server automatically.

Allowed preview commands are intentionally narrow and pass through the same safe terminal runner used by the Terminal MVP. Destructive or unknown commands are blocked instead of executed.

## Not implemented

Embedded browser preview is not part of this MVP. Karo opens applied static files externally or runs an explicit command and detects localhost URLs from terminal output.

## Safety rules

- Preview never applies staged artifacts.
- Preview never executes a command without a user click.
- Preview does not open staged-only files as if they were already in the project.
- Preview uses project-root path validation before opening local HTML.
- Preview command execution uses the terminal allowlist and command policy.
