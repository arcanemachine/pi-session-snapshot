# Changelog

## 0.2.0

- Add independently authorized `snapshot_save` and `snapshot_restore` agent tools.
- Add optional literal prompt submission after an authorized snapshot restore.
- Add flat global/trusted-project settings and `/snapshot agent` permission controls.
- Require Pi 0.99.2 or later for deferred command dispatch and fresh-session prompt delivery.

## 0.1.6

- Include the gallery logo in the published package.

## 0.1.5

- Add `-f` as a shorthand for `--force` on `/snapshot save` and `/snapshot delete`; the two forms cannot be combined and unknown dash flags are rejected.
- Autocomplete `--force` and `-f` after `/snapshot save` and `/snapshot delete`, with or without a name; completion values preserve the typed action and name.

## 0.1.4

- Fix npm image metadata

## 0.1.3

- Use smaller logo

## 0.1.2

- Document the parent Pi extensions project.

## 0.1.1

- Add logo

## 0.1.0

- Add top-level argument autocompletion for `/snapshot save|load|list|delete`.
- `/snapshot list` now shows the directory where snapshots are stored.
- Simplify the save-collision menu to a binary "Overwrite it? (No/Yes)" confirm, removing the redundant "Save as another name" choice that behaved identically to Cancel.

- Add named snapshots of the current Pi session's active root-to-leaf path.
- Add interactive and direct `/snapshot` save, load, list, and delete actions.
- Restore snapshots as new sessions using Pi's native fork semantics.
- Remove unused restored-session files on supported graceful lifecycle transitions.
- Fix interactive `/snapshot` load to stop the command flow after a successful session replacement, instead of reopening the action menu with a now-stale pre-replacement command context.
