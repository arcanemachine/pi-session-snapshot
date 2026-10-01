import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { Type } from "typebox";
import {
  permissionGuidance,
  resolvePermission,
  type AgentAction,
} from "./authorization.js";
import { formatSnapshotError } from "./errors.js";
import { normalizeSnapshotName, resolveSnapshotFile } from "./names.js";
import type { SnapshotPaths } from "./paths.js";
import { forkSnapshot, saveSnapshot } from "./snapshots.js";
import type { FlowContext } from "./ui/flow.js";

export interface SnapshotAgentBridge {
  queueSave(input: PendingSaveInput): QueueOperationResult;
  queueRestore(input: PendingRestoreInput): QueueOperationResult;
  dispatchAfterSettled(ctx: ExtensionContext): void;
  invalidateForSession(
    sessionId: string,
    ui: Pick<ExtensionContext["ui"], "notify">,
  ): void;
  cancelForShutdown(ui: Pick<ExtensionContext["ui"], "notify">): void;
  consumeSave(token: string, ctx: ExtensionContext): PendingSave | null;
  consumeRestore(token: string, ctx: ExtensionContext): PendingRestore | null;
}

export interface PendingSaveInput {
  name: string;
  force: boolean;
  sessionId: string;
  sessionFile?: string;
}

export interface PendingSave extends PendingSaveInput {
  token: string;
}

export interface PendingRestoreInput {
  name: string;
  prompt?: string;
  sessionId: string;
  sessionFile?: string;
}

export interface PendingRestore extends PendingRestoreInput {
  token: string;
}

export type QueueOperationResult =
  | { queued: true; token: string }
  | { queued: false; reason: string };

function textResult(
  text: string,
  details: unknown = {},
): {
  content: [{ type: "text"; text: string }];
  details: unknown;
} {
  return { content: [{ type: "text", text }], details };
}

function errorResult(error: unknown): {
  content: [{ type: "text"; text: string }];
  details: { error: string };
  isError: true;
} {
  const message = formatSnapshotError(error);
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
    isError: true,
  };
}

function actionPermission(action: AgentAction): boolean {
  return resolvePermission(action).allowed;
}

function currentSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

const DISPATCH_TIMEOUT_MS = 30_000;

type PendingOperation =
  | { action: "save"; request: PendingSave }
  | { action: "restore"; request: PendingRestore };

class SnapshotAgentBridgeImpl implements SnapshotAgentBridge {
  private pending?: PendingOperation;
  private dispatchedToken?: string;
  private dispatchTimer?: ReturnType<typeof setTimeout>;
  private dispatching = false;

  queueSave(input: PendingSaveInput): QueueOperationResult {
    return this.queue({
      action: "save",
      request: { ...input, token: randomUUID() },
    });
  }

  queueRestore(input: PendingRestoreInput): QueueOperationResult {
    return this.queue({
      action: "restore",
      request: { ...input, token: randomUUID() },
    });
  }

  dispatchAfterSettled(ctx: ExtensionContext): void {
    const pending = this.pending;
    if (
      !pending ||
      this.dispatching ||
      this.dispatchedToken === pending.request.token
    ) {
      return;
    }
    if (pending.request.sessionId !== currentSessionId(ctx)) {
      this.clearPending();
      ctx.ui.notify(
        `SNAPSHOT_${pending.action === "save" ? "CREATE" : "LOAD"}_FAILED: The queued agent ${pending.action} request became stale before it could run.`,
        "warning",
      );
      return;
    }
    if (!actionPermission(pending.action)) {
      this.clearPending();
      ctx.ui.notify(permissionGuidance(pending.action), "warning");
      return;
    }

    this.dispatching = true;
    this.dispatchedToken = pending.request.token;
    this.dispatchTimer = setTimeout(() => {
      if (this.dispatchedToken !== pending.request.token) return;
      this.clearPending();
      ctx.ui.notify(
        `SNAPSHOT_${pending.action === "save" ? "CREATE" : "LOAD"}_FAILED: The queued agent ${pending.action} request was not dispatched.`,
        "error",
      );
    }, DISPATCH_TIMEOUT_MS);
    this.dispatchTimer.unref?.();

    try {
      this.api.sendUserMessage(
        `/snapshot agent-${pending.action} ${pending.request.token}`,
        { expandPromptTemplates: true },
      );
    } catch (error) {
      this.clearPending();
      ctx.ui.notify(formatSnapshotError(error), "error");
    } finally {
      this.dispatching = false;
    }
  }

  invalidateForSession(
    sessionId: string,
    ui: Pick<ExtensionContext["ui"], "notify">,
  ): void {
    if (!this.pending || this.pending.request.sessionId === sessionId) return;
    const action = this.pending.action;
    this.clearPending();
    ui.notify(
      `SNAPSHOT_${action === "save" ? "CREATE" : "LOAD"}_FAILED: The queued agent ${action} request became stale before it could run.`,
      "warning",
    );
  }

  cancelForShutdown(ui: Pick<ExtensionContext["ui"], "notify">): void {
    if (!this.pending) return;
    const action = this.pending.action;
    this.clearPending();
    ui.notify(
      `SNAPSHOT_${action === "save" ? "CREATE" : "LOAD"}_FAILED: The queued agent ${action} request was cancelled during session shutdown.`,
      "warning",
    );
  }

  consumeSave(token: string, ctx: ExtensionContext): PendingSave | null {
    const pending = this.pending;
    if (
      !pending ||
      pending.action !== "save" ||
      pending.request.token !== token
    ) {
      return null;
    }
    if (pending.request.sessionId !== currentSessionId(ctx)) {
      this.clearPending();
      return null;
    }
    this.clearPending();
    return pending.request;
  }

  consumeRestore(token: string, ctx: ExtensionContext): PendingRestore | null {
    const pending = this.pending;
    if (
      !pending ||
      pending.action !== "restore" ||
      pending.request.token !== token
    ) {
      return null;
    }
    if (pending.request.sessionId !== currentSessionId(ctx)) {
      this.clearPending();
      return null;
    }
    this.clearPending();
    return pending.request;
  }

  private queue(operation: PendingOperation): QueueOperationResult {
    if (this.pending) {
      return {
        queued: false,
        reason: `Another snapshot ${this.pending.action} request is already queued for the current agent run.`,
      };
    }
    this.pending = operation;
    return { queued: true, token: operation.request.token };
  }

  private clearPending(): void {
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = undefined;
    this.pending = undefined;
    this.dispatchedToken = undefined;
  }

  constructor(private readonly api: Pick<ExtensionAPI, "sendUserMessage">) {}
}

export function createSnapshotAgentBridge(
  api: Pick<ExtensionAPI, "sendUserMessage">,
): SnapshotAgentBridge {
  return new SnapshotAgentBridgeImpl(api);
}

export function registerSnapshotTools(
  pi: ExtensionAPI,
  pathsProvider: () => SnapshotPaths,
  bridge: SnapshotAgentBridge,
): void {
  pi.registerTool({
    name: "snapshot_save",
    label: "Save Snapshot",
    description:
      "Queue a save of the active Pi session path as a named snapshot after the current agent run settles. Requires user authorization via /snapshot agent save allow.",
    parameters: Type.Object({
      name: Type.String({ description: "Snapshot name" }),
      force: Type.Optional(
        Type.Boolean({
          description: "Replace an existing snapshot with this name",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!actionPermission("save")) {
        return errorResult(permissionGuidance("save"));
      }
      try {
        const name = normalizeSnapshotName(params.name);
        const queued = bridge.queueSave({
          name,
          force: params.force === true,
          sessionId: currentSessionId(ctx),
          sessionFile: ctx.sessionManager.getSessionFile(),
        });
        if (!queued.queued) return errorResult(new Error(queued.reason));
        return textResult(
          `Queued saving session snapshot "${name}" until the current agent run settles.`,
          { name, force: params.force === true, token: queued.token },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  pi.registerTool({
    name: "snapshot_restore",
    label: "Restore Snapshot",
    description:
      "Queue restoration of a named Pi session snapshot after the current agent run settles, optionally submitting one literal prompt after the fork. Requires user authorization via /snapshot agent restore allow.",
    parameters: Type.Object({
      name: Type.String({ description: "Snapshot name" }),
      prompt: Type.Optional(
        Type.String({
          description: "Optional literal prompt to submit after restoration",
        }),
      ),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!actionPermission("restore")) {
        return errorResult(permissionGuidance("restore"));
      }
      try {
        const name = normalizeSnapshotName(params.name);
        const snapshotFile = resolveSnapshotFile(
          pathsProvider().snapshotDir,
          name,
        );
        if (!existsSync(snapshotFile)) {
          return errorResult(
            new Error(
              `SNAPSHOT_NOT_FOUND: No session snapshot named "${name}" was found.`,
            ),
          );
        }
        const prompt = params.prompt?.trim() ? params.prompt : undefined;
        const queued = bridge.queueRestore({
          name,
          prompt,
          sessionId: currentSessionId(ctx),
          sessionFile: ctx.sessionManager.getSessionFile(),
        });
        if (!queued.queued) return errorResult(new Error(queued.reason));
        return textResult(
          `Queued restoration of session snapshot "${name}" until the current agent run settles.${prompt ? " The literal prompt will be submitted in the restored session." : ""}`,
          { name, token: queued.token },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

export async function runPendingSave(
  pending: PendingSave,
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
): Promise<void> {
  await ctx.waitForIdle();
  if (ctx.sessionManager.getSessionId() !== pending.sessionId) {
    ui.notify(
      "SNAPSHOT_CREATE_FAILED: The queued agent save request became stale before it could run.",
      "warning",
    );
    return;
  }
  if (!actionPermission("save")) {
    ui.notify(permissionGuidance("save"), "warning");
    return;
  }
  const sessionFile = ctx.sessionManager.getSessionFile();
  const leafId = ctx.sessionManager.getLeafId();
  if (!sessionFile) {
    ui.notify(
      "SESSION_NOT_PERSISTED: The current session has not been persisted to disk.",
      "error",
    );
    return;
  }
  if (!leafId) {
    ui.notify("SESSION_EMPTY: The current session has no entries.", "error");
    return;
  }
  try {
    const result = saveSnapshot(
      {
        snapshotDir: paths.snapshotDir,
        name: pending.name,
        sourceSessionFile: sessionFile,
        leafId,
      },
      { replace: pending.force },
    );
    ui.notify(`Saved session snapshot "${result.name}".`, "info");
  } catch (error) {
    ui.notify(formatSnapshotError(error), "error");
  }
}

export async function runPendingRestore(
  pending: PendingRestore,
  ctx: FlowContext,
  paths: SnapshotPaths,
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void },
): Promise<void> {
  await ctx.waitForIdle();
  if (ctx.sessionManager.getSessionId() !== pending.sessionId) {
    ui.notify(
      "SNAPSHOT_LOAD_FAILED: The queued agent restore request became stale before it could run.",
      "warning",
    );
    return;
  }
  if (!actionPermission("restore")) {
    ui.notify(permissionGuidance("restore"), "warning");
    return;
  }
  let destinationFile: string;
  try {
    destinationFile = forkSnapshot({
      snapshotDir: paths.snapshotDir,
      name: pending.name,
      targetCwd: ctx.cwd,
      targetSessionDir: ctx.sessionManager.getSessionDir(),
    }).destinationFile;
  } catch (error) {
    ui.notify(formatSnapshotError(error), "error");
    return;
  }

  let replacementStarted = false;
  let result: { cancelled: boolean };
  try {
    result = await ctx.switchSession(destinationFile, {
      withSession: async (replacement) => {
        replacementStarted = true;
        if (!pending.prompt) return;
        try {
          await replacement.sendUserMessage(pending.prompt, {
            expandPromptTemplates: false,
          });
        } catch (error) {
          replacement.ui.notify(formatSnapshotError(error), "error");
        }
      },
    });
  } catch (error) {
    if (!replacementStarted) {
      try {
        if (existsSync(destinationFile)) unlinkSync(destinationFile);
      } catch {
        // best-effort cleanup
      }
    }
    ui.notify(formatSnapshotError(error), "error");
    return;
  }
  if (result.cancelled) {
    if (!replacementStarted) {
      try {
        if (existsSync(destinationFile)) unlinkSync(destinationFile);
      } catch {
        // best-effort cleanup
      }
    }
    ui.notify(
      "SNAPSHOT_LOAD_FAILED: Loading the session snapshot was cancelled.",
      "warning",
    );
  }
}
