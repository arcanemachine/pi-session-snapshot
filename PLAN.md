# pi-session-snapshot implementation plan

## Status

Ready for implementation after the required session compaction.

This plan is the durable implementation contract for the initial local build. The child repository will be implemented and committed locally, then integrated into the `pi-projects` superproject as a Git submodule. Nothing will be pushed.

`PLAN.md` is a temporary execution artifact. It must be deleted after the planned child implementation, documentation, and verification are complete, before the final child-package state is delivered. The final published/tracked package tree must contain the normal maintained sibling-package files, not this plan file.

## Product definition

`pi-session-snapshot` saves the active path of a persisted Pi session as a named JSONL file and uses that file as a reusable source for new forked sessions.

A snapshot contains Pi session history, not workspace state. It preserves the selected session path from the root through the current leaf, including the session entry types Pi retains on that path. It deliberately excludes alternate session branches.

A snapshot does not preserve or restore:

- repository or Git history;
- working-tree contents or uncommitted changes;
- filesystem state;
- environment variables;
- running processes;
- external files referenced by session metadata;
- extension state that was never persisted as a session entry.

Code, paths, diffs, and command output already present in messages or tool results remain ordinary session content, but the underlying files are not copied.

## Accepted decisions

- Package, repository, and project name: `pi-session-snapshot`.
- npm package name: `@arcanemachine/pi-session-snapshot`.
- Short user command: `/snapshot`.
- Snapshot directory: `join(getAgentDir(), "pi-session-snapshot")`.
- Snapshot filenames: `<name>.jsonl`.
- Saved content: the current active root-to-leaf path, not the complete session tree.
- Restore behavior: match native `pi --fork`; use the current working directory as the target working directory.
- Startup restore for V1: native `pi --fork <snapshot-path>`; no custom `--snapshot` flag.
- Other CLI and extension flags remain launch-time inputs and are not frozen into the snapshot.
- No LLM-callable tool in V1. Snapshot mutation remains explicitly user-controlled through `/snapshot`.
- Interactive overwrite protection: a safe-default collision menu.
- Programmatic overwrite: explicit `--force`.
- Best-effort cleanup: remove a restored fork after a graceful unused exit or session replacement when it received no new turn/session message.
- GitHub destination: `git@github.com:arcanemachine/pi-session-snapshot.git`.
- The user will create/push the GitHub repository. The implementation agent makes local commits only.

## Terminology

- **Source session**: the currently active Pi session from which a snapshot is saved.
- **Active path**: the session entries reached by walking from the current leaf to the root and reversing the result.
- **Snapshot**: a named JSONL session file in the snapshot directory containing only the active path.
- **Restored fork**: a new normal Pi session created from a snapshot by `SessionManager.forkFrom()`.
- **Provisional restored fork**: a restored fork that has not yet received new meaningful session activity and can therefore be removed without losing new work.
- **Meaningful activity**: a new agent run or a new session message not present in the source snapshot. Administrative entries alone, such as a model selection or session name, do not need to retain an otherwise-unused restored fork.

## Command surface

One extension command will be registered:

```text
/snapshot
```

It supports both interactive and direct forms:

```text
/snapshot
/snapshot save [name] [--force]
/snapshot load [name]
/snapshot list
/snapshot delete [name] [--force]
```

### Direct-command parsing

- The first token is the action.
- Supported actions are `save`, `load`, `list`, and `delete`.
- `--force` is valid only for `save` and `delete`.
- Snapshot names cannot contain whitespace, so shell-style quoted-name parsing is unnecessary in V1.
- Duplicate positional names, unknown flags, missing required direct-mode arguments, and extra arguments produce concise usage errors.
- `--force` may appear before or after the name after the action.
- Direct forms must not unexpectedly open selection or input UI in non-TUI modes.
- Direct `save` and `delete` without `--force` fail safely on an overwrite/deletion condition when interactive resolution is unavailable.

## Snapshot names

Names are user-facing filename stems.

Accepted input examples:

```text
baseline
baseline-v2
research.context
my_snapshot
baseline.jsonl
```

Normalization and validation:

- trim surrounding whitespace;
- accept an optional final `.jsonl` suffix and remove it before validation;
- reject an empty stem;
- reject `/`, `\\`, absolute paths, `.` and `..`;
- allow ASCII letters, numbers, `.`, `_`, and `-`;
- require the first and last stem characters to be alphanumeric;
- append exactly one `.jsonl` suffix when resolving the filesystem path;
- preserve the supplied case, while documenting that lowercase kebab-case is the portable convention;
- resolve the target and verify that it remains directly inside the configured snapshot directory.

The implementation will expose pure name-normalization and path-resolution functions for unit testing.

## Storage and security

Default layout:

```text
~/.pi/agent/
└── pi-session-snapshot/
    ├── baseline.jsonl
    └── investigation.jsonl
```

Requirements:

- derive the agent directory from Pi's exported `getAgentDir()`;
- allow path injection in internal APIs/tests so automated tests never touch the real agent directory;
- create the snapshot directory recursively with restrictive permissions where supported;
- set snapshot files to owner-readable/writable permissions where supported;
- never follow a user-supplied relative path outside the snapshot directory;
- enumerate only direct `.jsonl` entries;
- sort names deterministically;
- avoid modifying the source session file;
- keep snapshots immutable during restore;
- use temporary/generated files inside the snapshot directory and clean them after both success and failure;
- avoid leaving generated UUID/timestamp session files beside named snapshots.

## Saving algorithm

Saving must use Pi's session semantics rather than implementing a second session-format parser.

1. Obtain `ctx.sessionManager.getSessionFile()` and `getLeafId()`.
2. Reject an ephemeral or not-yet-persisted session with a clear error.
3. Reject a session with no current leaf.
4. Ensure the persisted source file exists.
5. Create the snapshot directory.
6. Open a separate `SessionManager` for the source file, passing the snapshot directory as the destination session directory.
7. Call `createBranchedSession(currentLeafId)` on that separate manager.
8. Pi extracts the active root-to-leaf path, retains the applicable entry types, removes alternate branches, and recreates path labels.
9. Verify that the generated JSONL file exists. A missing generated file means the source had not reached Pi's persistence threshold.
10. Move the completed generated file to the normalized named destination.
11. For create-only behavior, fail if the named destination already exists.
12. For an approved replacement, atomically replace the destination where the platform supports atomic rename replacement.
13. Apply restrictive file permissions where supported.
14. Clean up the generated file on every failure path.

Saving a linear session will usually be close in size to the source. Saving a branched session will be smaller when excluded branches contain entries. Large tool results or embedded images on the active path can still produce a large snapshot.

## Overwrite behavior

### Interactive save flow

When the selected name does not exist, save immediately.

When it exists, show a safe-default collision menu:

```text
Snapshot "baseline" already exists

> Cancel
  Replace
  Save as another name
```

Rules:

- `Cancel` is initially selected.
- Escape has the same behavior as `Cancel`.
- Cancel returns to the previous save-name input.
- The previously entered name is preserved.
- The input cursor is restored at the end of the preserved value.
- `Replace` performs the atomic replacement without another confirmation.
- `Save as another name` returns to the name input with the prior value preserved and the cursor at the end for editing.
- A collision reached through `/snapshot save baseline` in TUI mode enters the same nested flow; backing out exposes a prefilled save-name input rather than requiring the full command to be retyped.

### Programmatic save flow

```text
/snapshot save baseline --force
```

- `--force` performs create-or-replace without UI.
- Without `--force`, a collision in a non-interactive flow fails with an actionable error.
- The default storage-layer API remains create-only; replacement must be explicitly requested by the caller.

## Interactive navigation

Running `/snapshot` with no arguments in TUI mode opens a top-level action menu:

```text
Save snapshot
Load snapshot
Delete snapshot
List snapshots
```

Navigation contract:

- Enter descends into the selected action.
- Escape returns exactly one level.
- Escape at the top level closes the snapshot UI.
- Re-entered list menus preserve their previous hovered index where practical.
- Returning from collision handling preserves the save name and places the cursor at the end.
- Empty snapshot catalogs show an informative screen/message and return safely.
- Destructive selections use safe defaults.
- Completion and error notifications remain concise.

### Save UI

1. Show a single-line name input.
2. Preserve the current input value across nested collision UI.
3. Validate on submit; on validation failure, notify and reopen with the entered text preserved.
4. On success, notify with the saved name and return to the top-level menu.
5. Escape returns to the top-level menu without writing.

### Load UI

1. List snapshots by normalized filename stem.
2. Preserve the list hover when returning from a nested screen.
3. Enter restores the selected snapshot as a new session.
4. Escape returns to the top-level menu.
5. Session replacement terminates the old command context; post-switch work uses only the `withSession` replacement context.

### Delete UI

1. List snapshots.
2. Selecting a snapshot opens a safe-default confirmation menu.
3. Cancel/Escape returns to the snapshot list with the same item hovered.
4. Confirm deletes only the named snapshot file and returns to the list.
5. The snapshot directory itself remains.

### List UI

Show the sorted snapshot catalog with concise metadata that can be obtained safely, such as filename and file size. V1 does not need to parse and render full conversation previews. Escape returns to the top-level menu.

## Loading algorithm

### From `/snapshot load`

1. Normalize the selected name and resolve its path.
2. Verify the snapshot exists and is a regular JSONL file.
3. Wait for the current agent runtime to become idle with `ctx.waitForIdle()`.
4. Use `SessionManager.forkFrom(snapshotPath, ctx.cwd, ctx.sessionManager.getSessionDir())`.
5. Confirm that the returned manager has a destination session file.
6. Call `ctx.switchSession(destinationPath, { withSession })`.
7. Use only the replacement context inside `withSession`; never use captured session-bound objects after replacement.
8. Notify success from the replacement context.
9. If `session_before_switch` cancels the switch, remove the just-created destination file and remain in the original session.
10. Never append to or switch directly onto the snapshot file.

### From process startup

Document the native V1 form:

```bash
pi --fork ~/.pi/agent/pi-session-snapshot/baseline.jsonl
```

Additional launch flags remain effective:

```bash
pi \
  --fork ~/.pi/agent/pi-session-snapshot/baseline.jsonl \
  --inter-agent some-agent \
  --model openai/gpt-5.4 \
  --thinking high
```

Native Pi restrictions still apply: `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.

## Provisional restored-session cleanup

Pi immediately creates the destination file for a fork containing prior assistant messages. V1 will remove unused restored forks on graceful lifecycle transitions where it is safe to do so.

Identification:

- inspect the active session header during `session_start`;
- treat the session as snapshot-derived only when `parentSession` resolves to a direct named JSONL file inside the configured snapshot directory;
- never treat the snapshot file itself as the provisional destination;
- open/read the parent snapshot through Pi's session APIs to establish the baseline entry IDs;
- if the parent snapshot is absent or invalid, do not schedule deletion.

Use detection:

- mark the provisional session used when an `agent_start` event occurs;
- also retain it when shutdown inspection finds a new message entry not present in the snapshot baseline;
- do not retain it solely because of inherited entries or administrative entries created without a turn;
- after reload, reconstruct provisional state from the header and current entries rather than relying on module memory.

Cleanup:

- do nothing on `session_shutdown` with reason `reload`;
- on `quit`, `new`, `resume`, or `fork`, remove the provisional destination if it remains unused;
- verify the destination is not the snapshot and is the same active session file before removal;
- use force-safe file removal and report cleanup failures only as warnings, never as fatal session-shutdown errors;
- cleanup is best-effort and cannot guarantee removal after `SIGKILL`, machine failure, or process crash.

The implementation must avoid deleting a previously used snapshot-derived session when it is resumed later. Baseline entry comparison is therefore required; `parentSession` alone is insufficient.

## Deletion algorithm

- Normalize and contain the name exactly as for save/load.
- Require the path to exist as a direct regular file in the snapshot directory.
- Interactive deletion requires a safe-default confirmation.
- Direct/programmatic deletion requires `--force`.
- Remove only the selected snapshot file.
- A missing file is an explicit not-found error rather than silently succeeding.

## Error model

Use typed extension-local errors with stable codes suitable for tests and programmatic diagnostics. Expected categories include:

- `INVALID_NAME`
- `SESSION_NOT_PERSISTED`
- `SESSION_EMPTY`
- `SNAPSHOT_EXISTS`
- `SNAPSHOT_NOT_FOUND`
- `SNAPSHOT_INVALID`
- `SNAPSHOT_CREATE_FAILED`
- `SNAPSHOT_LOAD_FAILED`
- `SNAPSHOT_DELETE_FAILED`
- `UI_UNAVAILABLE`
- `INVALID_ARGUMENT`

User notifications should be formatted as `CODE: message` for errors. Internal causes should be preserved where useful without exposing credentials or unrelated sensitive content.

## Proposed source layout

```text
pi-session-snapshot/
├── .gitignore
├── AGENTS.md
├── CHANGELOG.md
├── LICENSE.md
├── README.md
├── package.json
├── src/
│   ├── command.ts
│   ├── errors.ts
│   ├── index.ts
│   ├── names.ts
│   ├── paths.ts
│   ├── provisional.ts
│   ├── snapshots.ts
│   ├── types.ts
│   └── ui/
│       ├── components.ts
│       └── flow.ts
├── tests/
│   ├── command.test.ts
│   ├── extension.integration.test.ts
│   ├── helpers.ts
│   ├── names.test.ts
│   ├── provisional.test.ts
│   ├── snapshots.test.ts
│   └── ui-flow.test.ts
└── tsconfig.json
```

Files may be combined when implementation shows that separation would create trivial one-use abstractions. The final package should remain smaller and simpler than `pi-workflow`; it must not grow a generic repository/service framework.

The final project must include the usual independently maintained extension-package surface used by sibling projects: `.gitignore`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE.md`, `README.md`, `package.json`, `tsconfig.json`, source files, and tests. Add other standard configuration only when it is actually used. `PLAN.md` exists only during execution and is intentionally absent from the final tree.

## Package metadata and conventions

Match maintained packages in the `pi-projects` superproject:

- source-loaded TypeScript under `src/`;
- ESM package;
- `pi.extensions` pointing to `./src/index.ts`;
- Pi packages listed as optional peer dependencies with `"*"` ranges;
- exact compatible Pi versions in development dependencies;
- no unnecessary runtime dependencies;
- TypeScript, Vitest, and Prettier scripts;
- Node engine compatible with the maintained siblings;
- `files` allowlist containing source and user documentation;
- npm discoverability keywords including `pi-package`;
- public publish configuration;
- MIT license using the existing author/year convention;
- conventional local commits;
- no build artifacts or package tarballs committed.

## Extension entrypoint

`src/index.ts` will:

- register exactly one `/snapshot` command;
- register the minimal session lifecycle handlers needed for provisional cleanup;
- avoid tools, providers, resources, background timers, and startup filesystem mutation;
- resolve production paths through a small injectable path provider;
- keep session-scoped state reconstructible after reload/session replacement.

## Test strategy

All filesystem tests use unique temporary agent/session directories and clean them after each test. Tests must never read or mutate the real `~/.pi/agent/pi-session-snapshot` directory.

### Name and path tests

- valid stems;
- optional `.jsonl` suffix;
- invalid empty names;
- separators and traversal attempts;
- absolute paths;
- invalid leading/trailing punctuation;
- containment in the snapshot directory;
- deterministic list sorting.

### Snapshot save tests

Construct real temporary Pi sessions with `SessionManager`:

- reject an unpersisted blank session;
- save a linear active path;
- create a branched source and prove only the selected root-to-leaf path is retained;
- retain relevant non-message entries and labels on the active path;
- omit alternate-branch entries;
- create the expected named file;
- leave no generated UUID/timestamp file behind;
- refuse an existing name by default;
- replace only when explicitly requested;
- preserve the old snapshot if replacement preparation fails;
- keep the source session unchanged;
- apply expected permissions where portable to assert.

### Snapshot load tests

- fork a valid snapshot into the requested cwd/session directory;
- assign a new session ID and destination file;
- copy snapshot entries without mutating the snapshot;
- set `parentSession` to the snapshot path;
- reject missing and invalid snapshots;
- clean a newly created destination when session switching is cancelled at the command layer.

### Command tests

- register exactly one command and no tool;
- parse every supported direct form;
- reject unknown actions/flags and extra arguments;
- require `--force` for noninteractive overwrite/delete;
- route no-argument TUI use into the interactive flow;
- reject no-argument use outside TUI with an actionable usage message;
- use `waitForIdle()` before load;
- do not reuse a stale command context after replacement;
- produce stable error codes.

### UI-flow tests

Use a scripted UI abstraction rather than terminal keypresses for orchestration tests:

- top-level Escape exits;
- nested Escape returns one level;
- save validation returns to the input with preserved text;
- collision Cancel returns to the name input with the same value;
- collision Save-as returns to the input with the same value;
- collision Replace writes once;
- cursor-end behavior is covered by a focused component test or live acceptance test;
- delete cancellation returns to the same list index;
- load/delete empty-catalog behavior;
- top-level menu hover preservation where implemented.

### Provisional cleanup tests

- recognize a fork whose `parentSession` is a snapshot;
- ignore ordinary forks from outside the snapshot directory;
- ignore invalid or missing parents;
- remove an unused restored session on graceful quit/switch;
- retain it across reload;
- retain it after `agent_start`;
- retain it when a new message entry exists beyond the snapshot baseline;
- do not mistake inherited snapshot entries for new use;
- never remove the source snapshot;
- do not delete a previously used session when it is resumed later.

### Integration test

Load the extension entrypoint against a fake `ExtensionAPI` and assert:

- one command named `snapshot`;
- required lifecycle handlers only;
- no tool registrations or load-time side effects.

## Verification sequence

Inside the child repository:

```bash
npm run typecheck
npm run test
npm run build
npm run format
npm pack --dry-run
```

Run formatting before the final verification pass, then rerun checks if formatting changes source or tests.

From the superproject root:

```bash
pnpm install
pnpm --filter @arcanemachine/pi-session-snapshot run typecheck
pnpm --filter @arcanemachine/pi-session-snapshot run test
pnpm --filter @arcanemachine/pi-session-snapshot run build
pnpm run typecheck
pnpm run test
pnpm run build
```

Use the superproject's documented Vitest capture workaround if the harness returns empty output.

## Live acceptance verification

After automated checks pass, request/confirm live verification before declaring the behavior complete, following workspace instructions.

Use an isolated `PI_AGENT_DIR` and isolated session directory so real snapshots and sessions are untouched. Exercise Pi in tmux without killing an attached session.

Acceptance scenarios:

1. Create a real multi-turn session and save a named snapshot.
2. Create or navigate a branch, save at the selected leaf, and verify the snapshot excludes the alternate path.
3. Trigger a name collision, cancel, and verify the prior name returns with the cursor at the end.
4. Trigger a collision and replace through the menu.
5. Load through `/snapshot load` and continue with a new turn; verify the snapshot file remains unchanged.
6. Launch with native `pi --fork <snapshot>` and another extension flag; verify both the session history and launch-time flag behavior.
7. Load/fork a snapshot, exit without a new turn, and verify the provisional session file is removed.
8. Load/fork a snapshot, send a turn, exit, and verify the new session remains available in `/resume`.
9. Delete a snapshot, cancel once to verify hover/back navigation, then confirm deletion.

Do not call the feature verified solely because unit tests pass; exercise the running Pi TUI.

## Superproject integration

After the child package is complete and committed:

1. Register `packages/pi-session-snapshot` as a Git submodule with URL `git@github.com:arcanemachine/pi-session-snapshot.git`.
2. Ensure the child Git directory is represented correctly as submodule metadata rather than ordinary tracked package files.
3. Add the child extension path to root `package.json`:

   ```text
   ./packages/pi-session-snapshot/src/index.ts
   ```

4. Add `pi-session-snapshot` to the root README package list.
5. Run `pnpm install` so `pnpm-lock.yaml` gains the workspace importer.
6. Validate from the root.
7. Commit the child repository first.
8. Commit `.gitmodules`, the submodule pointer, root manifest, root README, and lockfile in the superproject second.
9. Do not touch unrelated submodule state, including the currently uninitialized `packages/pi-retry` checkout.
10. Do not push either repository.

Because the remote may not exist yet, local commits and submodule metadata can still be prepared. Before the user pushes the superproject, the child repository must be created remotely and the child `main` branch pushed first so external recursive clones can resolve the recorded gitlink.

## Implementation phases

### Phase 1: Child package foundation

- Add the normal sibling-project files: `.gitignore`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE.md`, `README.md`, `package.json`, and `tsconfig.json`.
- Add source and test directories with independently usable package behavior.
- Add TypeScript/Vitest/Prettier configuration.
- Add path, name, error, and core snapshot modules.
- Add foundational unit tests.
- Confirm no real agent directory is touched.

Exit criteria:

- package installs/resolves in the workspace;
- name/path tests pass;
- real `SessionManager` tests prove active-path extraction.

### Phase 2: Command and interactive UI

- Add the direct command parser.
- Add reusable selection and prefilled single-line input components.
- Add the top-level menu and nested save/load/delete/list flows.
- Implement safe collision and deletion menus.
- Preserve input and hover state across back-navigation.
- Add command and scripted-flow tests.

Exit criteria:

- direct programmatic operations are deterministic;
- interactive collision cancellation preserves the name;
- no LLM tool is registered.

### Phase 3: Restore lifecycle and cleanup

- Implement load/fork/switch orchestration.
- Implement provisional restored-session detection.
- Implement graceful unused cleanup and reload reconstruction.
- Add lifecycle tests.

Exit criteria:

- restored sessions never write to snapshots;
- cancelled switches clean their generated destination;
- unused graceful restores are removed;
- used restores survive.

### Phase 4: Documentation and child verification

- Write user-focused README examples and explicit non-goals.
- Document native `--fork` startup and flag composition.
- Complete changelog and all usual sibling-package metadata/instructions.
- Run all child checks and package dry run.
- Review the tarball allowlist.
- Confirm the final tree contains `.gitignore`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE.md`, `README.md`, `package.json`, `tsconfig.json`, source, and tests.
- Once every child implementation/documentation/check item in this plan is complete, delete `PLAN.md` as explicitly required by the user.
- Re-run any check affected by final cleanup, verify `PLAN.md` is absent, and commit the complete child package locally.

Exit criteria:

- child repository is independently usable;
- automated checks pass;
- child commit exists on local `main`.

### Phase 5: Superproject integration

- Convert/register the child as a proper submodule.
- Update root manifest, README, and lockfile.
- Run root validation.
- Commit superproject integration locally.

Exit criteria:

- superproject records a mode-160000 gitlink;
- `.gitmodules` has the intended path and URL;
- root single-install manifest loads the extension;
- root checks pass;
- no unrelated files/submodules are staged.

### Phase 6: Live verification and closeout

- Obtain permission for live running-system verification if not already explicit.
- Run the isolated tmux acceptance scenarios.
- Fix forward and rerun relevant checks for failures.
- Report local child and superproject commit hashes.
- Tell the user the required push order: child repository first, superproject second.

Exit criteria:

- feature behavior is observed in a running Pi instance;
- no test snapshots remain in the real agent directory;
- no pushes were performed;
- worktree and submodule states are clearly reported.

## Commit plan

Local child repository commits should remain coherent. A likely sequence is:

1. `docs: add implementation plan`
2. `feat: add session snapshot management`
3. `docs: document session snapshot usage`

The exact implementation/docs split may be reduced to one implementation commit if that produces a more coherent initial package. The planning commit remains separate because compaction depends on it as a durable handoff, but the implementation sequence must delete `PLAN.md` before the final child-package state is committed. Its planning history may remain in Git; the working tree and final package must not contain the file.

Superproject commit:

```text
Add pi-session-snapshot package
```

Stage explicit paths only. Never stage unrelated workspace or submodule changes.

## Risks and mitigations

### Session format evolution

Risk: manual JSONL transformation becomes stale.

Mitigation: use Pi's public `SessionManager` operations for opening, branch extraction, context semantics, and forking. Keep manual handling limited to named-file placement and lifecycle bookkeeping.

### Snapshot mistaken for workspace backup

Risk: users expect code/history restoration.

Mitigation: package name includes `session`; README begins with explicit scope and non-goals; command output says “session snapshot.”

### Accidental overwrite or deletion

Risk: a reusable baseline is lost.

Mitigation: create-only storage default, safe-default interactive menus, explicit `--force` for automation, and atomic replacement preparation.

### Stale command context after load

Risk: using captured `pi` or command context after session replacement throws or mutates the wrong runtime.

Mitigation: use only plain captured paths/names before replacement and the `withSession` context after replacement.

### Orphaned fork files

Risk: load creates a destination before a switch is cancelled or before the user performs a turn.

Mitigation: remove cancelled-switch destinations immediately; recognize snapshot-derived provisional sessions and remove unused ones during graceful lifecycle transitions.

### Incorrect cleanup of used sessions

Risk: `parentSession` remains a snapshot forever, so header-only detection could delete legitimate resumed work.

Mitigation: compare against snapshot baseline entry IDs and retain sessions containing new message entries or observed agent activity.

### Hard-crash leftovers

Risk: no shutdown handler runs after `SIGKILL` or machine failure.

Mitigation: document cleanup as best-effort. Do not add a broad global garbage collector in V1.

### Submodule confusion

Risk: child files are accidentally tracked as ordinary superproject files or the superproject is committed before the child is available.

Mitigation: keep the child as an independent Git repository, verify gitlink mode, commit child first, and tell the user to push child first.

## Explicit non-goals for V1

- Git/worktree/filesystem snapshots.
- Restoring code or external artifacts.
- Capturing the full branched session tree.
- Merging snapshots.
- Editing snapshot JSONL.
- Import/export to formats other than Pi JSONL.
- Cloud sync or sharing.
- Snapshot compression.
- Automatic periodic snapshots.
- LLM-callable snapshot mutation tools.
- A custom `--snapshot` Pi startup flag.
- Integration changes to `pi-subagent`, inter-agent, or other launchers.
- Global cleanup scans across every session directory.
- Backward-compatibility layers for unreleased formats.

## Definition of done

The work is complete when:

- `/snapshot` provides the accepted interactive hierarchy;
- direct save/load/list/delete forms work with explicit programmatic guards;
- collision cancellation preserves the entered name and restores the cursor at the end;
- snapshots contain only the current active session path;
- alternate branches and workspace state are not captured;
- native `pi --fork` starts a new session from a named snapshot in the current cwd;
- current launch flags remain effective;
- snapshots remain unchanged after restored sessions continue;
- unused restored sessions are removed on supported graceful exits;
- used restored sessions remain;
- unit, integration, package, root, and live acceptance verification pass;
- the final child tree contains the usual maintained package files (`.gitignore`, `AGENTS.md`, `CHANGELOG.md`, `LICENSE.md`, `README.md`, `package.json`, `tsconfig.json`, source, and tests);
- `PLAN.md` has been deleted after completion and is absent from the final child tree;
- child and superproject commits exist locally in the required order;
- no remote push has occurred;
- documentation clearly states scope, usage, security, limitations, and push order.

## Open questions

None. Any new behavior discovered during implementation that changes the accepted command surface, storage semantics, cleanup safety, or repository structure must be surfaced to the user before proceeding with that change.
