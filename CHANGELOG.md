# Changelog

## 0.1.0 - Unreleased

- Add named snapshots of the current Pi session's active root-to-leaf path.
- Add interactive and direct `/snapshot` save, load, list, and delete actions.
- Restore snapshots as new sessions using Pi's native fork semantics.
- Remove unused restored-session files on supported graceful lifecycle transitions.
