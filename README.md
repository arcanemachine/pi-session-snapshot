# pi-session-snapshot

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-session-snapshot/main/logo.jpg" alt="pi-session-snapshot logo" width="250" />
</p>

Save and restore the active path of a given Pi session.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

Useful for establishing a checkpoint from which you want to resume one or more sessions, such as when you have a fleet of worker agents who you don't want to onboard before each task.

> A session snapshot preserves Pi conversation context only. It does not preserve Git history, files, uncommitted changes, environment variables, or processes.

## Requirements

- Pi 0.99.2 or later
- Node.js 22.19.0 or later for package development

## Installation

### From GitHub

```bash
pi install git:github.com/arcanemachine/pi-session-snapshot
```

### From npm

```bash
pi install npm:@arcanemachine/pi-session-snapshot
```

### From local clone

```bash
pi install /path/to/pi-session-snapshot
```

Or load the source entrypoint directly during development:

```bash
pi -e /path/to/pi-session-snapshot/src/index.ts
```

## Commands

```text
/snapshot
/snapshot save [name] [--force|-f]
/snapshot load [name]
/snapshot list
/snapshot delete [name] [--force|-f]
/snapshot agent status
/snapshot agent [save|restore|all] [allow|deny|reset]
```

Running `/snapshot` opens a menu for saving, loading, deleting, and listing snapshots. Saving an existing name opens a safe-default confirm: **No** / **Yes** — answering **No** returns to the name field with the entered value intact (so you can save it under a different name), and **Yes** overwrites.

The top-level actions (`save`, `load`, `list`, `delete`, `agent`) are autocompleted after `/snapshot `. Agent targets and decisions are also completed. `--force` / `-f` are autocompleted after `/snapshot save ` or `/snapshot delete `, with or without a name. `/snapshot list` prints the directory where snapshots are stored along with the saved snapshots.

For automation or non-TUI use, `--force` is required to replace or delete:

```text
/snapshot save baseline --force
/snapshot delete baseline -f
```

Without `--force`, an existing noninteractive save fails rather than overwriting, and noninteractive deletion fails rather than deleting.

### Agent tools

The extension registers two agent-callable tools, both denied by default:

- `snapshot_save` queues a save of the active session path until the current agent run settles. It accepts `name` and optional `force: true`.
- `snapshot_restore` requests restoration of a named snapshot and ends the originating run at the safe tool-batch boundary. It accepts `name` and an optional literal `prompt` that is submitted exactly once in the new session.

The user controls each capability independently:

```text
/snapshot agent status
/snapshot agent save allow
/snapshot agent restore allow
/snapshot agent save deny
/snapshot agent restore reset
/snapshot agent all deny
```

Filesystem saves and session replacement happen only after the current run safely settles. A save-only request captures the completed run and tool results. A restore request ends the run after the issued tool batch is finalized: there is no additional agent response in the original session before replacement.

An agent may request save and then restore of the same name in one run. The restore depends on that save succeeding; failure cancels the restore rather than loading an older file of the same name. In this chained case, the snapshot ends at the latest complete path before the assistant message containing the restore request. If both calls share an assistant message, the snapshot ends before that whole message. This excludes the restore call/result without rewriting transcript entries or leaving unmatched tool calls. Earlier user messages on that path are preserved.

A successful restore forks a new normal session. The new session receives a compact, persistent `Restored session snapshot "<name>".` entry visible to the user but excluded from agent context. It supplies no hidden guidance and does not start a run. A supplied prompt is delivered exactly once through the fresh session context; even a leading `/` is literal text, not a slash command. Without a prompt, the new session remains idle.

Agent tools cannot list or delete snapshots. Saving an existing name requires explicit `force: true`. Only one pending save with one dependent same-name restore is supported; unrelated or duplicate queued requests are rejected.

### Settings

Agent-tool defaults use Pi's normal settings files and the exact `pi-session-snapshot` namespace. Both settings default to `false`:

```json
{
  "pi-session-snapshot": {
    "agentSaveToolAllowed": true,
    "agentRestoreToolAllowed": false
  }
}
```

Global settings are read from `~/.pi/agent/settings.json`. A trusted project's `.pi/settings.json` may override either field independently; omitted project fields inherit the global value. Untrusted project settings are ignored. Invalid values fail closed and produce a warning. The `/snapshot agent ... allow|deny|reset` commands create process-local overrides that do not modify settings, snapshots, or conversation history; they survive extension reload and session replacement in the same Pi process but not process exit. Reload Pi after changing settings.

Snapshots are stored under:

```text
~/.pi/agent/pi-session-snapshot/<name>.jsonl
```

Snapshot names may contain letters, numbers, dots, underscores, and hyphens. They must begin and end with a letter or number; paths, whitespace, and traversal are rejected. Lowercase kebab-case is recommended.

## Start Pi from a snapshot

Use Pi's native fork option:

```bash
pi --fork ~/.pi/agent/pi-session-snapshot/baseline.jsonl
```

Other launch-time flags still compose with the fork:

```bash
pi \
  --fork ~/.pi/agent/pi-session-snapshot/baseline.jsonl \
  --model openai/gpt-5.4 \
  --thinking high
```

Pi does not allow `--fork` together with `--session`, `--continue`, `--resume`, or `--no-session`.

## Semantics

Saving extracts only the current root-to-leaf session path. Alternate branches are omitted. Messages, tool calls/results, compactions, model/thinking changes, and applicable extension entries on the selected path remain part of the Pi session history.

Loading creates a new session in the current working directory. The snapshot remains unchanged as the restored session continues. The active restored path can be branched normally after loading; it starts from the saved path, not from the source session's omitted branches.

If a restored session receives no new meaningful activity, the extension makes a best-effort attempt to remove its otherwise-unused session file during graceful shutdown or session replacement. A session that starts an agent turn or gains a new message is retained. Hard crashes can leave a file behind.

## Security

Session snapshots can contain prompts, model responses, tool output, paths, and other sensitive conversation context. The extension creates its snapshot directory and files with restrictive permissions where supported. Protect and review snapshots as you would normal Pi session files.

## Development

```bash
npm run typecheck
npm run test
npm run build
npm run format:check
npm pack --dry-run
```

`npm run format:check` verifies formatting without changing files. Use `npm run format` only for intentional package-wide reformatting. For focused work, format only the paths you changed, for example `npx prettier --write src/ui/flow.ts`.

Automated filesystem tests use isolated temporary directories and do not touch the real Pi agent directory.

## License

MIT
