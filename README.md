# pi-session-snapshot

<p align="center">
  <img src="https://raw.githubusercontent.com/arcanemachine/pi-session-snapshot/main/logo.jpg" alt="pi-session-snapshot logo" width="250" />
</p>

Save and restore the active path of a given Pi session.

> Like this extension? See [my other Pi extensions](https://github.com/arcanemachine/pi-projects).

Useful for establishing a checkpoint from which you want to resume one or more sessions, such as when you have a fleet of worker agents who you don't want to onboard before each task.

> A session snapshot preserves Pi conversation context only. It does not preserve Git history, files, uncommitted changes, environment variables, or processes.

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
```

Running `/snapshot` opens a menu for saving, loading, deleting, and listing snapshots. Saving an existing name opens a safe-default confirm: **No** / **Yes** — answering **No** returns to the name field with the entered value intact (so you can save it under a different name), and **Yes** overwrites.

The top-level actions (`save`, `load`, `list`, `delete`) are autocompleted after `/snapshot `, and `--force` / `-f` are autocompleted after `/snapshot save ` or `/snapshot delete `, with or without a name. `/snapshot list` prints the directory where snapshots are stored along with the saved snapshots.

For automation or non-TUI use, `--force` is required to replace or delete:

```text
/snapshot save baseline --force
/snapshot delete baseline -f
```

Without `--force`, an existing noninteractive save fails rather than overwriting, and noninteractive deletion fails rather than deleting.

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
