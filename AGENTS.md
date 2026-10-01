# Agent Instructions

## Product boundary

`pi-session-snapshot` saves the current Pi session's active root-to-leaf path as a named JSONL snapshot and restores it by forking a new normal session.

It preserves Pi session context only. It does not preserve Git history, working-tree files, uncommitted changes, environment variables, or processes. User-operated `/snapshot` commands remain the primary interface. The package also provides separately authorized LLM-callable save and restore tools; both are denied by default and must remain independently configurable. Do not add a custom startup flag unless a separately approved feature requires one.

## Package style

Match maintained sibling packages in the Pi superproject:

- source-loaded TypeScript under `src/`;
- `pi.extensions` package metadata;
- Pi packages as optional peer dependencies;
- no unnecessary runtime dependencies;
- Vitest, TypeScript, and Prettier;
- independently installable behavior.

Keep filesystem access injectable so automated tests never touch the real Pi agent directory. Keep modules focused; do not create generic service or repository frameworks.

## Configuration and agent-tool safety

- Read settings from Pi's normal global `settings.json` and trusted project `.pi/settings.json` under the exact `pi-session-snapshot` namespace. Trusted project fields override corresponding global fields; untrusted project settings are ignored.
- Keep the two agent permission keys flat-ish: `agentSaveToolAllowed` and `agentRestoreToolAllowed`. Both default to denied, and malformed values fail closed.
- User commands may create process-local permission overrides, but never persist those overrides in session entries, snapshots, transcripts, environment variables, or child-process arguments.

## Safety contracts

- Snapshot names are safe filename stems, never paths.
- Store production snapshots under `join(getAgentDir(), "pi-session-snapshot")`.
- Overwrite and programmatic deletion require explicit `--force` (`-f` is an accepted shorthand; the two forms cannot be combined).
- Interactive destructive menus must have a safe default.
- Save only the active session path; do not copy the full branch tree.
- Restore by forking; never append to or activate the snapshot file directly.
- Unused restored-session cleanup is best-effort and must never delete a used session or the source snapshot.

## Formatting discipline

Two scripts keep formatting intentional:

- `npm run format:check` — verifies only; never changes files. Use this in regular verification.
- `npm run format` — reformats the whole package. Use only for deliberate package-wide normalization.

For focused work, format only the paths you changed instead of running the package-wide `format`:

```bash
npx prettier --write src/ui/flow.ts tests/ui-flow.test.ts CHANGELOG.md
```

Before editing, run `npm run format:check`. If it already fails on untouched files, the package has pre-existing formatting drift: do not silently fold a package-wide reformat into a functional change. Either normalize it separately with explicit approval, or preserve the existing state and format only your own paths.

If package-wide formatting is needed, keep it in a standalone commit separate from behavioral changes, verify it is formatting-only by inspecting the full diff, using `git diff --ignore-all-space` as a noise-reduction aid (not proof — line wrapping and import reflow still appear in it), reviewing remaining changes manually, running `git diff --check`, and running typecheck and tests.

## Verification

For package changes, run:

```bash
npm run typecheck
npm run test
npm run build
npm run format:check
npm pack --dry-run
```

New user-facing UI/session behavior also requires live verification in an isolated Pi agent/session directory before it is called complete.

## Source control

Commit coherent completed work using Conventional Commits. Stage only package files. Commit this child repository before updating the Pi superproject pointer.

Do not push, publish, or release without explicit user authorization.
