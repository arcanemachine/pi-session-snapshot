import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resetPermissionState,
  setConfiguration,
} from "../src/authorization.js";
import {
  createSnapshotAgentBridge,
  registerSnapshotTools,
  runPendingRestore,
  runPendingSave,
  type SnapshotAgentBridge,
} from "../src/agent.js";
import { saveSnapshot } from "../src/snapshots.js";
import type { SnapshotPaths } from "../src/paths.js";
import type { FlowContext } from "../src/ui/flow.js";
import {
  appendAssistant,
  appendUser,
  cleanupTempDirectories,
  makeSessionDirectories,
} from "./helpers.js";

afterEach(() => {
  resetPermissionState();
  cleanupTempDirectories();
});

function setup() {
  const { cwd, sessions, agent } = makeSessionDirectories();
  const session = SessionManager.create(cwd, sessions);
  appendUser(session, "root");
  appendAssistant(session, "reply");
  const paths: SnapshotPaths = {
    agentDir: agent,
    snapshotDir: join(agent, "pi-session-snapshot"),
  };
  return { cwd, session, paths };
}

function toolContext(cwd: string, session: SessionManager) {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    sessionManager: session,
    ui: { notify() {} },
    isProjectTrusted: () => false,
    isIdle: () => false,
  };
}

describe("snapshot agent tools", () => {
  it("denies tools without configuration and performs no filesystem work", async () => {
    const { cwd, session, paths } = setup();
    const tools: any[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    registerSnapshotTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      () => paths,
      bridge,
    );

    const result = await tools[0].execute(
      "call",
      { name: "baseline" },
      undefined,
      undefined,
      toolContext(cwd, session),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("/snapshot agent save allow");
    expect(existsSync(join(paths.snapshotDir, "baseline.jsonl"))).toBe(false);
  });

  it("denies restore before checking the snapshot file", async () => {
    const { cwd, session, paths } = setup();
    setConfiguration({ save: false, restore: false });
    const tools: any[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    registerSnapshotTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      () => paths,
      bridge,
    );

    const result = await tools[1].execute(
      "call",
      { name: "missing" },
      undefined,
      undefined,
      toolContext(cwd, session),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("/snapshot agent restore allow");
  });

  it("queues authorized saves and preserves force overwrite behavior", async () => {
    const { cwd, session, paths } = setup();
    setConfiguration({ save: true, restore: false });
    const tools: any[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    registerSnapshotTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      () => paths,
      bridge,
    );
    const ctx = toolContext(cwd, session);
    const flow: FlowContext = {
      hasUI: true,
      cwd,
      sessionManager: session,
      async waitForIdle() {},
      async switchSession() {
        return { cancelled: false };
      },
    };
    const notifications: string[] = [];
    const ui = {
      notify(message: string) {
        notifications.push(message);
      },
    };

    const first = await tools[0].execute(
      "call",
      { name: "baseline" },
      undefined,
      undefined,
      ctx,
    );
    expect(first.isError).toBeUndefined();
    expect(first.content[0].text).toContain("Queued saving");
    const firstPending = bridge.consumeSave(
      (first.details as { token: string }).token,
      ctx as never,
    );
    expect(firstPending).not.toBeNull();
    const firstSucceeded = await runPendingSave(firstPending!, flow, paths, ui);
    bridge.finishSave(ctx as never, firstSucceeded);
    expect(firstSucceeded).toBe(true);
    expect(existsSync(join(paths.snapshotDir, "baseline.jsonl"))).toBe(true);

    const collision = await tools[0].execute(
      "call2",
      { name: "baseline" },
      undefined,
      undefined,
      ctx,
    );
    expect(collision.isError).toBeUndefined();
    const collisionPending = bridge.consumeSave(
      (collision.details as { token: string }).token,
      ctx as never,
    );
    const collisionSucceeded = await runPendingSave(
      collisionPending!,
      flow,
      paths,
      ui,
    );
    bridge.finishSave(ctx as never, collisionSucceeded);
    expect(collisionSucceeded).toBe(false);
    expect(notifications.at(-1)).toContain("SNAPSHOT_EXISTS");

    const replacement = await tools[0].execute(
      "call3",
      { name: "baseline", force: true },
      undefined,
      undefined,
      ctx,
    );
    expect(replacement.isError).toBeUndefined();
    const replacementPending = bridge.consumeSave(
      (replacement.details as { token: string }).token,
      ctx as never,
    );
    const replacementSucceeded = await runPendingSave(
      replacementPending!,
      flow,
      paths,
      ui,
    );
    bridge.finishSave(ctx as never, replacementSucceeded);
    expect(replacementSucceeded).toBe(true);
    expect(notifications.at(-1)).toContain('Saved session snapshot "baseline"');
  });

  it("chains restore after a pending save of the same name", async () => {
    const { cwd, session, paths } = setup();
    setConfiguration({ save: true, restore: true });
    const tools: any[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    registerSnapshotTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      () => paths,
      bridge,
    );
    const ctx = toolContext(cwd, session);

    const save = await tools[0].execute(
      "save",
      { name: "chain" },
      undefined,
      undefined,
      ctx,
    );
    const restore = await tools[1].execute(
      "restore",
      { name: "chain", prompt: "continue" },
      undefined,
      undefined,
      ctx,
    );

    expect(save.isError).toBeUndefined();
    expect(restore.isError).toBeUndefined();
    expect(restore.terminate).toBe(true);
  });

  it("queues an authorized restore and rejects a duplicate request", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    setConfiguration({ save: false, restore: true });
    const tools: any[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    registerSnapshotTools(
      { registerTool: (tool: unknown) => tools.push(tool) } as never,
      () => paths,
      bridge,
    );
    const ctx = toolContext(cwd, session);

    const first = await tools[1].execute(
      "call",
      { name: "baseline", prompt: "literal /command" },
      undefined,
      undefined,
      ctx,
    );
    const second = await tools[1].execute(
      "call2",
      { name: "baseline" },
      undefined,
      undefined,
      ctx,
    );

    expect(first.isError).toBeUndefined();
    expect(first.content[0].text).toContain("Queued restoration");
    expect(second.isError).toBe(true);
  });
});

describe("deferred restore bridge", () => {
  beforeEach(() => setConfiguration({ save: false, restore: true }));

  it("dispatches once after settlement and consumes the matching token", () => {
    setConfiguration({ save: false, restore: true });
    const sent: Array<{ text: string; options: unknown }> = [];
    const bridge = createSnapshotAgentBridge({
      sendUserMessage(text, options) {
        sent.push({
          text: typeof text === "string" ? text : "",
          options,
        });
      },
    });
    const ctx = {
      sessionManager: {
        getSessionId: () => "session-1",
      },
    } as never;
    const queued = bridge.queueRestore({
      name: "baseline",
      sessionId: "session-1",
    });
    expect(queued.queued).toBe(true);
    if (!queued.queued) throw new Error("Expected restore to queue");

    bridge.dispatchAfterSettled(ctx);
    bridge.dispatchAfterSettled(ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toMatch(/^\/snapshot agent-restore /);
    expect(sent[0]?.options).toEqual({ expandPromptTemplates: true });
    const token = sent[0]!.text.split(" ").at(-1)!;
    expect(bridge.consumeRestore(token, ctx)).toMatchObject({
      name: "baseline",
      sessionId: "session-1",
    });
  });

  it("dispatches a chained restore after the save completes", () => {
    setConfiguration({ save: true, restore: true });
    const sent: string[] = [];
    const bridge = createSnapshotAgentBridge({
      sendUserMessage(text) {
        sent.push(typeof text === "string" ? text : "");
      },
    });
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify() {} },
    } as never;
    const save = bridge.queueSave({
      name: "chain",
      force: false,
      sessionId: "session-1",
      leafId: "before-save",
    });
    if (!save.queued) throw new Error("Expected save to queue");
    const restore = bridge.queueRestore({
      name: "chain",
      sessionId: "session-1",
      prompt: "continue",
    });
    if (!restore.queued) throw new Error("Expected restore to queue");

    bridge.dispatchAfterSettled(ctx);
    const pendingSave = bridge.consumeSave(save.token, ctx);
    expect(pendingSave?.leafId).toBe("before-save");
    bridge.finishSave(ctx, true);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/^\/snapshot agent-restore /);
  });

  it("dispatches queued saves after settlement", () => {
    setConfiguration({ save: true, restore: false });
    const sent: string[] = [];
    const bridge = createSnapshotAgentBridge({
      sendUserMessage(text) {
        sent.push(typeof text === "string" ? text : "");
      },
    });
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify() {} },
    } as never;
    const queued = bridge.queueSave({
      name: "baseline",
      force: false,
      sessionId: "session-1",
    });
    if (!queued.queued) throw new Error("Expected save to queue");
    bridge.dispatchAfterSettled(ctx);
    expect(sent[0]).toBe(`/snapshot agent-save ${queued.token}`);
    expect(bridge.consumeSave(queued.token, ctx)).toMatchObject({
      name: "baseline",
      force: false,
    });
    bridge.finishSave(ctx, false);
  });

  it("clears a request when command dispatch fails synchronously", () => {
    setConfiguration({ save: false, restore: true });
    const notifications: string[] = [];
    const bridge = createSnapshotAgentBridge({
      sendUserMessage() {
        throw new Error("dispatch failed");
      },
    });
    const ctx = {
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as never;
    const queued = bridge.queueRestore({
      name: "baseline",
      sessionId: "session-1",
    });
    if (!queued.queued) throw new Error("Expected restore to queue");
    bridge.dispatchAfterSettled(ctx);
    expect(notifications).toContain("dispatch failed");
    expect(
      bridge.queueRestore({ name: "next", sessionId: "session-1" }).queued,
    ).toBe(true);
  });

  it("notifies and clears a request when dispatch times out", () => {
    vi.useFakeTimers();
    try {
      setConfiguration({ save: false, restore: true });
      const notifications: string[] = [];
      const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
      const ctx = {
        sessionManager: { getSessionId: () => "session-1" },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as never;
      const queued = bridge.queueRestore({
        name: "baseline",
        sessionId: "session-1",
      });
      if (!queued.queued) throw new Error("Expected restore to queue");
      bridge.dispatchAfterSettled(ctx);
      vi.advanceTimersByTime(30_000);
      expect(notifications[0]).toContain("was not dispatched");
      expect(
        bridge.queueRestore({ name: "next", sessionId: "session-1" }).queued,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending work during shutdown", () => {
    const notifications: string[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    expect(
      bridge.queueRestore({ name: "baseline", sessionId: "session-1" }).queued,
    ).toBe(true);
    bridge.cancelForShutdown({
      notify(message: string) {
        notifications.push(message);
      },
    });
    expect(notifications[0]).toContain("session shutdown");
    expect(
      bridge.queueRestore({ name: "next", sessionId: "session-1" }).queued,
    ).toBe(true);
  });

  it("notifies and clears a request when the session changes", () => {
    const notifications: string[] = [];
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    const queued = bridge.queueRestore({
      name: "baseline",
      sessionId: "old-session",
    });
    expect(queued.queued).toBe(true);
    bridge.invalidateForSession("new-session", {
      notify(message: string) {
        notifications.push(message);
      },
    });
    expect(notifications[0]).toContain("became stale");
    expect(
      bridge.queueRestore({ name: "next", sessionId: "new-session" }).queued,
    ).toBe(true);
  });

  it("drops a request when the originating session is no longer active", () => {
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    const queued = bridge.queueRestore({
      name: "baseline",
      sessionId: "old-session",
    });
    expect(queued.queued).toBe(true);
    if (!queued.queued) throw new Error("Expected restore to queue");
    bridge.dispatchAfterSettled({
      sessionManager: { getSessionId: () => "new-session" },
      ui: { notify() {} },
    } as never);
    expect(
      bridge.consumeRestore(queued.token, {
        sessionManager: { getSessionId: () => "old-session" },
      } as never),
    ).toBeNull();
    const next = bridge.queueRestore({
      name: "next",
      sessionId: "new-session",
    });
    expect(next.queued).toBe(true);
  });

  it("rechecks restore permission after waiting for idle", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const notifications: string[] = [];
    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
      },
      {
        hasUI: true,
        cwd,
        sessionManager: session,
        async waitForIdle() {
          setConfiguration({ save: false, restore: false });
        },
        async switchSession() {
          throw new Error("must not switch");
        },
      },
      paths,
      {
        notify(message: string) {
          notifications.push(message);
        },
      },
    );
    expect(notifications[0]).toContain("/snapshot agent restore allow");
  });

  it("cleans up a fork when replacement is cancelled", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    let destination: string | undefined;
    const flow: FlowContext = {
      hasUI: true,
      cwd,
      sessionManager: session,
      async waitForIdle() {},
      async switchSession(path) {
        destination = path;
        return { cancelled: true };
      },
    };
    const notifications: string[] = [];

    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
      },
      flow,
      paths,
      {
        notify(message) {
          notifications.push(message);
        },
      },
    );

    expect(destination).toBeDefined();
    expect(existsSync(destination!)).toBe(false);
    expect(notifications[0]).toContain("SNAPSHOT_LOAD_FAILED");
  });

  it("preserves a fork when cancellation follows replacement start", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    let destination: string | undefined;
    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
      },
      {
        hasUI: true,
        cwd,
        sessionManager: session,
        async waitForIdle() {},
        async switchSession(path, options) {
          destination = path;
          await options?.withSession?.({
            ui: { notify() {} },
            async sendUserMessage() {},
          });
          return { cancelled: true };
        },
      },
      paths,
      { notify() {} },
    );
    expect(destination).toBeDefined();
    expect(existsSync(destination!)).toBe(true);
  });

  it("records the restore only in the forked user-facing history", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    let destination: string | undefined;
    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
      },
      {
        hasUI: true,
        cwd,
        sessionManager: session,
        async waitForIdle() {},
        async switchSession(path) {
          destination = path;
          return { cancelled: false };
        },
      },
      paths,
      { notify() {} },
    );
    const forkEntries = SessionManager.open(destination!).getEntries();
    const sourceEntries = SessionManager.open(
      join(paths.snapshotDir, "baseline.jsonl"),
    ).getEntries();
    expect(
      forkEntries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-session-snapshot:restore",
      ),
    ).toBe(true);
    expect(
      sourceEntries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-session-snapshot:restore",
      ),
    ).toBe(false);
  });

  it("keeps the restored session active when the optional prompt fails", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const notifications: string[] = [];
    const flow: FlowContext = {
      hasUI: true,
      cwd,
      sessionManager: session,
      async waitForIdle() {},
      async switchSession(_path, options) {
        await options?.withSession?.({
          ui: {
            notify(message) {
              notifications.push(message);
            },
          },
          async sendUserMessage() {
            throw new Error("prompt failed");
          },
        });
        return { cancelled: false };
      },
    };

    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
        prompt: "literal prompt",
      },
      flow,
      paths,
      { notify() {} },
    );

    expect(notifications).toContain("prompt failed");
  });

  it("cleans up a fork when session replacement rejects", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    let destination: string | undefined;
    const notifications: string[] = [];
    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
      },
      {
        hasUI: true,
        cwd,
        sessionManager: session,
        async waitForIdle() {},
        async switchSession(path) {
          destination = path;
          throw new Error("switch failed");
        },
      },
      paths,
      {
        notify(message: string) {
          notifications.push(message);
        },
      },
    );
    expect(destination).toBeDefined();
    expect(existsSync(destination!)).toBe(false);
    expect(notifications).toContain("switch failed");
  });

  it("reports a fork failure without switching sessions", async () => {
    const { cwd, session, paths } = setup();
    const notifications: string[] = [];
    await runPendingRestore(
      {
        token: "token",
        name: "missing",
        sessionId: session.getSessionId(),
      },
      {
        hasUI: true,
        cwd,
        sessionManager: session,
        async waitForIdle() {},
        async switchSession() {
          throw new Error("must not switch");
        },
      },
      paths,
      {
        notify(message) {
          notifications.push(message);
        },
      },
    );
    expect(notifications[0]).toContain("SNAPSHOT_NOT_FOUND");
  });

  it("submits the optional prompt through the replacement context", async () => {
    const { cwd, session, paths } = setup();
    saveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const prompts: Array<{ text: string; options: unknown }> = [];
    const flow: FlowContext = {
      hasUI: true,
      cwd,
      sessionManager: session,
      async waitForIdle() {},
      async switchSession(_path, options) {
        await options?.withSession?.({
          ui: { notify() {} },
          async sendUserMessage(text, sendOptions) {
            prompts.push({
              text: typeof text === "string" ? text : "",
              options: sendOptions,
            });
          },
        });
        return { cancelled: false };
      },
    };

    await runPendingRestore(
      {
        token: "token",
        name: "baseline",
        sessionId: session.getSessionId(),
        prompt: "literal /not-a-command",
      },
      flow,
      paths,
      { notify() {} },
    );

    expect(prompts).toEqual([
      {
        text: "literal /not-a-command",
        options: { expandPromptTemplates: false },
      },
    ]);
  });
});
