# CLI reference (`pinacode`)

The `pinacode` command runs and manages PinaCode servers, background services, remote access, threads, workflows, and diagnostics. Run `pinacode --help` or `pinacode <command> --help` for full flags.

See [Install PinaCode](./install.md#command-line) to set up the command.

## Running and connecting

| Command                              | Description                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pinacode [path]` / `pinacode start` | Start a foreground server and open the web app (optionally in a project directory).                          |
| `pinacode serve`                     | Start the server without opening a browser (`--lan`, `--tailscale-serve`, `--host`, `--port`, `--base-dir`). |
| `pinacode app [path]`                | Open a directory as a project/thread in the running desktop app.                                             |
| `pinacode up`                        | Interactive setup for remote access plus background service (`--connect`, `--lan`, `--no-lan`, `--yes`).     |
| `pinacode connect`                   | Manage T3 Connect (`pinacode connect`, `status`, `logout`, `link`, `unlink`).                                |
| `pinacode status`                    | Show how other devices can reach this host (`--json`).                                                       |
| `pinacode pair`                      | Generate a one-time pairing URL / QR code (`--tailscale`, `--scope <scope>`).                                |

## Background service and updates

| Command                                   | Description                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinacode service`                        | Manage the background service (`install`, `status`, `restart`, `uninstall`, `protect [--undo]`). See [Background service](./background-service.md). |
| `pinacode update [version]`               | Update `pinacode` and the service (`--channel nightly`, `--allow-downgrade`, `--yes`).                                                              |
| `pinacode install` / `pinacode uninstall` | Install or remove the `pinacode` launcher and background service (keeps `~/.pinacode/userdata`).                                                    |

## Threads, projects, and workflows

| Command             | Description                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinacode thread`   | Script threads on the host (`start`, `send`, `show`, `list`; supports `--wait`, `--json`, `--worktree`, `--provider`, `--model`, `--option`). See [Host scripts](./outside-agents.md#scripts-on-the-host). |
| `pinacode project`  | Manage projects on the host (e.g. `pinacode project add <path> --track <folder>`).                                                                                                                         |
| `pinacode workflow` | Start and steer durable workflows (`start`, `list`, `show`, `resume`, `cancel`, `questions`, `signal`, `withdraw`, `hooks`, `store`). See [Workflows](./workflows.md).                                     |

## Environments, auth, themes, and policy

| Command                | Description                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pinacode environment` | Link or manage peer environments (`pinacode environment link <addr> --pairing-code <code> --access <mode>`, `--from <file>`).                          |
| `pinacode auth`        | Manage pairing codes, sessions, and T3 Connect device approvals (`pairing create`, `session list/revoke/issue`, `connect-device list/approve/revoke`). |
| `pinacode theme`       | Manage server-published themes (`set <id>`, `clear`, `show`). See [Appearance](./appearance.md#environment-themes).                                    |
| `pinacode policy`      | Validate, inspect, and generate MDM/GPO templates for [managed policies](./managed-policy.md) (`check`, `show`, `settings`, `templates`).              |

## Diagnostics and maintenance

| Command                  | Description                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pinacode doctor`        | Inspect database size and reclaim disk space (`--dry-run`, `--fix`).                                     |
| `pinacode browser setup` | One-time Linux host setup (AppArmor sandbox profile, libraries, fonts) for the headless preview browser. |
| `pinacode trace summary` | Summarize local server trace latency and errors (`--since 30m`, `--limit 50`).                           |
| `pinacode triage`        | Launch Claude Code, Codex, or Antigravity in your terminal with the T3 triage playbook.                  |
