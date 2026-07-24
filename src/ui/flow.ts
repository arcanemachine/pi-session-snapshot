import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { SnapshotError, formatSnapshotError } from "../errors.js";
import {
  deleteSnapshot,
  forkSnapshot,
  listSnapshots,
  saveSnapshot,
  type SnapshotEntry,
} from "../snapshots.js";
import { normalizeSnapshotName, resolveSnapshotFile } from "../names.js";
import type { SnapshotPaths } from "../paths.js";

export type ActionKind = "save" | "load" | "delete" | "list" | "cancel";

export interface ActionMenuResult {
  kind: ActionKind;
  index: number;
}

export type CollisionChoice = "cancel" | "replace" | "rename";

export interface PickedSnapshot {
  entry: SnapshotEntry;
  index: number;
}

/**
 * Scriptable interface for the snapshot command surface. Tests inject a fake
 * implementation; production code wires the TUI components into it.
 */
export interface SnapshotUI {
  selectAction(initialIndex: number): Promise<ActionMenuResult>;
  inputName(
    title: string,
    initial: string,
    placeholder?: string,
  ): Promise<string | null>;
  pickSnapshot(
    title: string,
    items: SnapshotEntry[],
    initialIndex: number,
  ): Promise<PickedSnapshot | null>;
  confirmReplacement(name: string): Promise<CollisionChoice>;
  confirmDelete(name: string): Promise<boolean>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  showList(items: SnapshotEntry[]): Promise<void>;
}

export interface FlowContext {
  /** Whether an interactive TUI is available. */
  hasUI: boolean;
  /** Current working directory, used as the restore target. */
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
    getSessionDir(): string;
  };
  waitForIdle(): Promise<void>;
  switchSession(
    sessionPath: string,
    options?: {
      withSession?: (ctx: unknown) => Promise<void> | void;
    },
  ): Promise<{ cancelled: boolean }>;
}

export const SNAPSHOT_COMMAND_DESCRIPTION =
  "Save and restore reusable snapshots of the active Pi session path.";

/**
 * Run the top-level interactive menu until the user cancels.
 */
export async function runInteractiveMenu(
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: SnapshotUI,
): Promise<void> {
  let index = 0;
  for (;;) {
    const result = await ui.selectAction(index);
    index = Math.max(result.index, 0);
    switch (result.kind) {
      case "cancel":
        return;
      case "save":
        await runSaveFlow(ctx, paths, ui, undefined, false);
        continue;
      case "load": {
        const outcome = await runLoadFlow(ctx, paths, ui, undefined);
        // A successful load replaced the session; the original command ctx is
        // now stale. Stop here so the menu never reuses it. A cancelled or
        // failed load leaves the original session active and may continue.
        if (outcome === "replaced") return;
        continue;
      }
      case "delete":
        await runDeleteFlow(ctx, paths, ui, undefined, false);
        continue;
      case "list":
        await runListFlow(ctx, paths, ui);
        continue;
    }
  }
}

export interface SaveRequest {
  /** Candidate name supplied on the command line, or undefined for picker. */
  name?: string;
  force: boolean;
}

export async function runSaveFlow(
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: SnapshotUI,
  name: string | undefined,
  force: boolean,
): Promise<void> {
  if (force) {
    if (!name) {
      ui.notify(
        "INVALID_ARGUMENT: /snapshot save --force requires a snapshot name.",
        "warning",
      );
      return;
    }
    try {
      performSave(ctx, paths, name, true);
      ui.notify(
        `Saved session snapshot "${normalizeSnapshotName(name)}".`,
        "info",
      );
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
    }
    return;
  }

  if (!ctx.hasUI) {
    if (!name) {
      ui.notify(
        "INVALID_ARGUMENT: /snapshot save requires a name outside TUI mode.",
        "warning",
      );
      return;
    }
    try {
      performSave(ctx, paths, name, false);
      ui.notify(
        `Saved session snapshot "${normalizeSnapshotName(name)}".`,
        "info",
      );
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
    }
    return;
  }

  let pending = name ?? "";
  let pendingSupplied = name !== undefined;
  for (;;) {
    let value: string | null;
    if (pendingSupplied) {
      value = pending;
      pendingSupplied = false;
    } else {
      value = await ui.inputName("Save session snapshot", pending, "baseline");
      if (value === null) return;
    }

    let normalized: string;
    try {
      normalized = normalizeSnapshotName(value);
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
      pending = value;
      continue;
    }

    const destination = resolveSnapshotFile(paths.snapshotDir, normalized);
    if (!existsSync(destination)) {
      try {
        performSave(ctx, paths, normalized, false);
        ui.notify(`Saved session snapshot "${normalized}".`, "info");
        return;
      } catch (error) {
        ui.notify(formatSnapshotError(error), "error");
        return;
      }
    }

    const choice = await ui.confirmReplacement(normalized);
    if (choice === "cancel" || choice === "rename") {
      // Preserve the entered name and return to the save-name input with
      // the cursor at the end of the preserved value.
      pending = value;
      continue;
    }
    // replace
    try {
      performSave(ctx, paths, normalized, true);
      ui.notify(`Replaced session snapshot "${normalized}".`, "info");
      return;
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
      return;
    }
  }
}

export type LoadFlowOutcome = "replaced" | "unchanged";

export async function runLoadFlow(
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: SnapshotUI,
  name: string | undefined,
): Promise<LoadFlowOutcome> {
  let target: string;
  if (name) {
    target = name;
  } else if (ctx.hasUI) {
    const items = listSnapshots(paths.snapshotDir);
    if (items.length === 0) {
      ui.notify("No session snapshots are saved yet.", "warning");
      return "unchanged";
    }
    const picked = await ui.pickSnapshot("Load session snapshot", items, 0);
    if (!picked) return "unchanged";
    target = picked.entry.name;
  } else {
    ui.notify(
      "INVALID_ARGUMENT: /snapshot load requires a name outside TUI mode.",
      "warning",
    );
    return "unchanged";
  }

  await ctx.waitForIdle();
  let destinationFile: string;
  try {
    destinationFile = forkSnapshot({
      snapshotDir: paths.snapshotDir,
      name: target,
      targetCwd: ctx.cwd,
      targetSessionDir: ctx.sessionManager.getSessionDir(),
    }).destinationFile;
  } catch (error) {
    ui.notify(formatSnapshotError(error), "error");
    return "unchanged";
  }

  // Pi shows its native "Resumed session" status after a successful switch,
  // so no post-replacement work is needed here. Do not touch the original
  // command ctx after replacement; the caller checks the returned outcome.
  const result = await ctx.switchSession(destinationFile);

  if (result.cancelled) {
    // The switch was rejected by a session_before_switch handler; remove the
    // just-created fork so it does not orphan in the session directory. The
    // original session is still active, so the menu may continue.
    try {
      if (existsSync(destinationFile)) unlinkSync(destinationFile);
    } catch {
      // best-effort
    }
    ui.notify(
      "SNAPSHOT_LOAD_FAILED: Loading the session snapshot was cancelled.",
      "warning",
    );
    return "unchanged";
  }

  return "replaced";
}

export async function runDeleteFlow(
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: SnapshotUI,
  name: string | undefined,
  force: boolean,
): Promise<void> {
  if (force) {
    if (!name) {
      ui.notify(
        "INVALID_ARGUMENT: /snapshot delete --force requires a snapshot name.",
        "warning",
      );
      return;
    }
    try {
      deleteSnapshot(paths.snapshotDir, name);
      ui.notify(
        `Deleted session snapshot "${normalizeSnapshotName(name)}".`,
        "info",
      );
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
    }
    return;
  }

  if (!ctx.hasUI) {
    ui.notify(
      "INVALID_ARGUMENT: /snapshot delete requires --force outside TUI mode.",
      "warning",
    );
    return;
  }

  let suppliedName: string | undefined;
  if (name !== undefined) {
    try {
      suppliedName = normalizeSnapshotName(name);
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
      return;
    }
  }
  let index = 0;
  let targetName: string | undefined = suppliedName;
  let supplied = suppliedName !== undefined;
  for (;;) {
    let entry: SnapshotEntry | null;
    if (supplied) {
      const items = listSnapshots(paths.snapshotDir);
      const match = items.find((item) => item.name === suppliedName) ?? null;
      entry = match ?? null;
      supplied = false;
      if (!entry) {
        ui.notify(
          `SNAPSHOT_NOT_FOUND: No session snapshot named "${name}".`,
          "error",
        );
        return;
      }
    } else {
      const items = listSnapshots(paths.snapshotDir);
      if (items.length === 0) {
        ui.notify("No session snapshots are saved yet.", "warning");
        return;
      }
      const picked = await ui.pickSnapshot(
        "Delete session snapshot",
        items,
        index,
      );
      if (!picked) return;
      entry = picked.entry;
      index = picked.index;
    }
    targetName = entry.name;

    const confirmed = await ui.confirmDelete(targetName);
    if (!confirmed) {
      continue;
    }
    try {
      deleteSnapshot(paths.snapshotDir, targetName);
      ui.notify(`Deleted session snapshot "${targetName}".`, "info");
      return;
    } catch (error) {
      ui.notify(formatSnapshotError(error), "error");
      return;
    }
  }
}

export async function runListFlow(
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: SnapshotUI,
): Promise<void> {
  const items = listSnapshots(paths.snapshotDir);
  if (!ctx.hasUI) {
    if (items.length === 0) {
      ui.notify("No session snapshots are saved yet.", "info");
      return;
    }
    ui.notify(
      [
        "Session snapshots:",
        ...items.map((item) => `  ${item.name} (${formatBytes(item.bytes)})`),
      ].join("\n"),
      "info",
    );
    return;
  }
  await ui.showList(items);
}

function performSave(
  ctx: FlowContext,
  paths: SnapshotPaths,
  name: string,
  replace: boolean,
): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const leafId = ctx.sessionManager.getLeafId();
  if (!sessionFile) {
    throw new SnapshotError(
      "SESSION_NOT_PERSISTED",
      "The current session has not been persisted to disk.",
    );
  }
  if (!leafId) {
    throw new SnapshotError(
      "SESSION_EMPTY",
      "The current session has no entries.",
    );
  }
  saveSnapshot(
    {
      snapshotDir: paths.snapshotDir,
      name,
      sourceSessionFile: sessionFile,
      leafId,
    },
    { replace },
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

/** Exposed for command-layer tests to drive runInteractiveMenu directly. */
export function createFlowContext(ctx: {
  hasUI: boolean;
  cwd: string;
  sessionManager: Pick<
    SessionManager,
    "getSessionFile" | "getLeafId" | "getSessionDir"
  >;
  waitForIdle(): Promise<void>;
  switchSession(
    sessionPath: string,
    options?: {
      withSession?: (ctx: unknown) => Promise<void> | void;
    },
  ): Promise<{ cancelled: boolean }>;
}): FlowContext {
  return ctx;
}
