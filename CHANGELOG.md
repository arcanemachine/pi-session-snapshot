# Changelog

## 0.1.0 - Unreleased

- Add top-level argument autocompletion for `/snapshot save|load|list|delete`.
- `/snapshot list` now shows the directory where snapshots are stored.
- Simplify the save-collision menu to a binary "Overwrite it? (No/Yes)" confirm, removing the redundant "Save as another name" choice that behaved identically to Cancel.

- Add named snapshots of the current Pi session's active root-to-leaf path.
- Add interactive and direct `/snapshot` save, load, list, and delete actions.
- Restore snapshots as new sessions using Pi's native fork semantics.
- Remove unused restored-session files on supported graceful lifecycle transitions.
- Fix interactive `/snapshot` load to stop the command flow after a successful session replacement, instead of reopening the action menu with a now-stale pre-replacement command context.
