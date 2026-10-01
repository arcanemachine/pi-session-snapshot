import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import piSessionSnapshot from "../src/index.js";
import {
  completeSnapshotActions,
  createSnapshotCommandHandler,
  parseSnapshotCommand,
  registerSnapshotCommand,
} from "../src/command.js";
import {
  getOverride,
  resetPermissionState,
  setConfiguration,
} from "../src/authorization.js";
import { createSnapshotAgentBridge } from "../src/agent.js";
import type { SnapshotPaths } from "../src/paths.js";
import { SNAPSHOT_COMMAND_DESCRIPTION } from "../src/ui/flow.js";
import {
  appendAssistant,
  appendUser,
  cleanupTempDirectories,
  makeSessionDirectories,
} from "./helpers.js";

afterEach(() => {
  cleanupTempDirectories();
  resetPermissionState();
});

describe("parseSnapshotCommand", () => {
  it("parses interactive, list, and direct forms", () => {
    expect(parseSnapshotCommand("")).toEqual({
      action: "interactive",
      force: false,
    });
    expect(parseSnapshotCommand("list")).toEqual({
      action: "list",
      force: false,
    });
    expect(parseSnapshotCommand("save baseline")).toEqual({
      action: "save",
      name: "baseline",
      force: false,
    });
    expect(parseSnapshotCommand("save baseline --force")).toEqual({
      action: "save",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("save --force baseline")).toEqual({
      action: "save",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("save baseline -f")).toEqual({
      action: "save",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("save -f baseline")).toEqual({
      action: "save",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("delete baseline -f")).toEqual({
      action: "delete",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("delete -f baseline")).toEqual({
      action: "delete",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("delete baseline --force")).toEqual({
      action: "delete",
      name: "baseline",
      force: true,
    });
    expect(parseSnapshotCommand("load baseline")).toEqual({
      action: "load",
      name: "baseline",
      force: false,
    });
    expect(parseSnapshotCommand("agent status")).toEqual({
      action: "agent",
      agentDecision: "status",
      force: false,
    });
    expect(parseSnapshotCommand("agent save allow")).toEqual({
      action: "agent",
      agentTarget: "save",
      agentDecision: "allow",
      force: false,
    });
    expect(parseSnapshotCommand("agent all reset")).toEqual({
      action: "agent",
      agentTarget: "all",
      agentDecision: "reset",
      force: false,
    });
    expect(parseSnapshotCommand("agent-save token")).toEqual({
      action: "agent-save",
      token: "token",
      force: false,
    });
  });

  it("rejects unknown actions and flags", () => {
    expect(() => parseSnapshotCommand("frobnicate")).toThrow();
    expect(() => parseSnapshotCommand("save --bogus")).toThrow();
    expect(() => parseSnapshotCommand("save -x")).toThrow();
    expect(() => parseSnapshotCommand("list --force")).toThrow();
    expect(() => parseSnapshotCommand("load --force")).toThrow();
    expect(() => parseSnapshotCommand("load -f")).toThrow();
    expect(() => parseSnapshotCommand("list baseline")).toThrow();
    expect(() => parseSnapshotCommand("save a b")).toThrow();
    expect(() => parseSnapshotCommand("save --force --force x")).toThrow();
    expect(() => parseSnapshotCommand("save --force -f x")).toThrow();
    expect(() => parseSnapshotCommand("agent save")).toThrow();
    expect(() => parseSnapshotCommand("agent nope allow")).toThrow();
    expect(() => parseSnapshotCommand("agent save maybe")).toThrow();
  });
});

describe("command handler", () => {
  it("rejects the no-argument interactive command outside TUI mode", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const session = SessionManager.create(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "reply");
    const notifications: Array<{ message: string; type?: string }> = [];
    const handler = createSnapshotCommandHandler(() => ({
      agentDir: agent,
      snapshotDir: join(agent, "pi-session-snapshot"),
    }));

    await handler("", {
      hasUI: false,
      cwd,
      sessionManager: session,
      ui: {
        notify: (message: string, type?: string) =>
          notifications.push({ message, type }),
      },
    } as never);

    expect(notifications[0]?.message).toContain("UI_UNAVAILABLE");
  });

  it("saves directly outside TUI and waits for idle before direct load", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const paths: SnapshotPaths = {
      agentDir: agent,
      snapshotDir: join(agent, "pi-session-snapshot"),
    };
    const session = SessionManager.create(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "reply");
    const notifications: Array<{ message: string; type?: string }> = [];
    let idleCalls = 0;
    let destination: string | undefined;
    const handler = createSnapshotCommandHandler(() => paths);
    const context = {
      hasUI: false,
      cwd,
      sessionManager: session,
      ui: {
        notify: (message: string, type?: string) =>
          notifications.push({ message, type }),
      },
      async waitForIdle() {
        idleCalls += 1;
      },
      async switchSession(sessionPath: string) {
        destination = sessionPath;
        return { cancelled: true };
      },
    };

    await handler("save baseline", context as never);
    expect(notifications[0]?.message).toContain(
      'Saved session snapshot "baseline"',
    );

    await handler("load baseline", context as never);
    expect(idleCalls).toBe(1);
    expect(destination).toBeDefined();
    expect(notifications.at(-1)?.message).toContain("SNAPSHOT_LOAD_FAILED");
  });

  it("requires force for direct non-TUI deletion", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const session = SessionManager.create(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "reply");
    const paths: SnapshotPaths = {
      agentDir: agent,
      snapshotDir: join(agent, "pi-session-snapshot"),
    };
    const notifications: Array<{ message: string; type?: string }> = [];
    const handler = createSnapshotCommandHandler(() => paths);
    const context = {
      hasUI: false,
      cwd,
      sessionManager: session,
      ui: {
        notify: (message: string, type?: string) =>
          notifications.push({ message, type }),
      },
    };

    await handler("save baseline", context as never);
    await handler("delete baseline", context as never);
    expect(notifications.at(-1)?.message).toContain("requires --force");
    await handler("delete baseline --force", context as never);
    expect(notifications.at(-1)?.message).toContain(
      'Deleted session snapshot "baseline"',
    );
  });
});

describe("agent permission command", () => {
  it("rejects an internal restore after permission is revoked", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const session = SessionManager.create(cwd, sessions);
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    const queued = bridge.queueRestore({
      name: "baseline",
      sessionId: session.getSessionId(),
    });
    if (!queued.queued) throw new Error("Expected restore to queue");
    setConfiguration({ save: false, restore: false });
    const notifications: string[] = [];
    const handler = createSnapshotCommandHandler(
      () => ({
        agentDir: agent,
        snapshotDir: join(agent, "pi-session-snapshot"),
      }),
      bridge,
    );

    await handler(`agent-restore ${queued.token}`, {
      cwd,
      isProjectTrusted: () => false,
      hasUI: false,
      sessionManager: session,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as never);

    expect(notifications[0]).toContain("/snapshot agent restore allow");
  });

  it("cancels a dependent restore when save permission is revoked", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const session = SessionManager.create(cwd, sessions);
    const bridge = createSnapshotAgentBridge({ sendUserMessage() {} });
    setConfiguration({ save: true, restore: true });
    const save = bridge.queueSave({
      name: "chain",
      force: false,
      sessionId: session.getSessionId(),
    });
    expect(save.queued).toBe(true);
    const restore = bridge.queueRestore({
      name: "chain",
      sessionId: session.getSessionId(),
    });
    expect(restore.queued).toBe(true);
    setConfiguration({ save: false, restore: true });
    const notifications: string[] = [];
    const handler = createSnapshotCommandHandler(
      () => ({
        agentDir: agent,
        snapshotDir: join(agent, "pi-session-snapshot"),
      }),
      bridge,
    );

    await handler(`agent-save ${save.queued ? save.token : "missing"}`, {
      cwd,
      isProjectTrusted: () => false,
      hasUI: false,
      sessionManager: session,
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
    } as never);

    expect(notifications.join("\n")).toContain("/snapshot agent save allow");
    expect(
      bridge.queueRestore({
        name: "next",
        sessionId: session.getSessionId(),
      }).queued,
    ).toBe(true);
  });

  it("changes granular process-local permissions and reports status", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const notifications: Array<{ message: string; type?: string }> = [];
    const handler = createSnapshotCommandHandler(() => ({
      agentDir: agent,
      snapshotDir: join(agent, "pi-session-snapshot"),
    }));
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
      sessionManager: SessionManager.create(cwd, sessions),
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
      },
    };

    await handler("agent save allow", context as never);
    expect(getOverride("save")).toBe(true);
    await handler("agent restore deny", context as never);
    expect(getOverride("restore")).toBe(false);
    await handler("agent status", context as never);
    expect(notifications.at(-1)?.message).toContain("save: allowed");
    expect(notifications.at(-1)?.message).toContain("restore: denied");
    await handler("agent all reset", context as never);
    expect(getOverride("save")).toBeNull();
    expect(getOverride("restore")).toBeNull();
  });
});

describe("completeSnapshotActions", () => {
  it("offers every top-level action for an empty prefix", () => {
    expect(
      completeSnapshotActions("")
        ?.map((item) => item.value)
        .sort(),
    ).toEqual(["agent", "delete", "list", "load", "save"]);
  });

  it("narrows to a single matching action by prefix", () => {
    expect(completeSnapshotActions("sa")?.map((item) => item.value)).toEqual([
      "save",
    ]);
  });

  it("returns null when the prefix matches no action", () => {
    expect(completeSnapshotActions("frobnicate")).toBeNull();
  });

  it("returns null once the prefix has moved past the action token", () => {
    expect(completeSnapshotActions("save ")).toBeNull();
    expect(
      completeSnapshotActions("agent s")?.map((item) => item.value),
    ).toEqual(["agent status", "agent save"]);
    expect(
      completeSnapshotActions("agent save ")?.map((item) => item.value),
    ).toEqual(["agent save allow", "agent save deny", "agent save reset"]);
    expect(completeSnapshotActions("agent status")).toBeNull();
    expect(completeSnapshotActions("agent save allow")).toBeNull();
    expect(completeSnapshotActions("agent all reset")).toBeNull();
    expect(completeSnapshotActions("save baseline")).toBeNull();
  });

  it("completes force flags with the full action and name prefix", () => {
    expect(completeSnapshotActions("save --f")).toEqual([
      {
        value: "save --force",
        label: "--force",
        description: "Overwrite or delete without confirmation",
      },
    ]);
    expect(completeSnapshotActions("save -")).toEqual([
      {
        value: "save --force",
        label: "--force",
        description: "Overwrite or delete without confirmation",
      },
      {
        value: "save -f",
        label: "-f",
        description: "Shorthand for --force",
      },
    ]);
    expect(completeSnapshotActions("delete baseline --f")).toEqual([
      {
        value: "delete baseline --force",
        label: "--force",
        description: "Overwrite or delete without confirmation",
      },
    ]);
    expect(completeSnapshotActions("delete baseline -")).toEqual([
      {
        value: "delete baseline --force",
        label: "--force",
        description: "Overwrite or delete without confirmation",
      },
      {
        value: "delete baseline -f",
        label: "-f",
        description: "Shorthand for --force",
      },
    ]);
  });

  it("stays silent for unknown flag prefixes and other actions", () => {
    expect(completeSnapshotActions("save -x")).toBeNull();
    expect(completeSnapshotActions("save --bogus")).toBeNull();
    expect(completeSnapshotActions("load -")).toBeNull();
    expect(completeSnapshotActions("list -")).toBeNull();
  });
});

describe("registerSnapshotCommand", () => {
  it("registers exactly the snapshot command with the approved description and completions", () => {
    let name: string | undefined;
    let description: string | undefined;
    let completions: ((prefix: string) => unknown) | undefined;
    registerSnapshotCommand({
      registerCommand(
        commandName: string,
        options: {
          description?: string;
          getArgumentCompletions?: (prefix: string) => unknown;
        },
      ) {
        name = commandName;
        description = options.description;
        completions = options.getArgumentCompletions;
      },
    } as never);
    expect(name).toBe("snapshot");
    expect(description).toBe(SNAPSHOT_COMMAND_DESCRIPTION);
    expect(completions).toBe(completeSnapshotActions);
  });
});

describe("extension entrypoint", () => {
  it("registers exactly one command and the cleanup lifecycle handlers", () => {
    const commands: string[] = [];
    const tools: string[] = [];
    const handlers: Record<string, unknown> = {};
    let entryRenderer: unknown;
    piSessionSnapshot({
      registerCommand(commandName: string) {
        commands.push(commandName);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerEntryRenderer(_customType: string, renderer: unknown) {
        entryRenderer = renderer;
      },
      on(event: string, handler: unknown) {
        handlers[event] = handler;
      },
    } as never);

    expect(commands).toEqual(["snapshot"]);
    expect(tools).toEqual(["snapshot_save", "snapshot_restore"]);
    expect(entryRenderer).toEqual(expect.any(Function));
    expect(handlers).toHaveProperty("session_start");
    expect(handlers).toHaveProperty("agent_start");
    expect(handlers).toHaveProperty("session_shutdown");
    expect(handlers).toHaveProperty("agent_settled");
  });
});
