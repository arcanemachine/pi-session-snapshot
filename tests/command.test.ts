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
import type { SnapshotPaths } from "../src/paths.js";
import { SNAPSHOT_COMMAND_DESCRIPTION } from "../src/ui/flow.js";
import {
  appendAssistant,
  appendUser,
  cleanupTempDirectories,
  makeSessionDirectories,
} from "./helpers.js";

afterEach(cleanupTempDirectories);

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
  });

  it("rejects unknown actions and flags", () => {
    expect(() => parseSnapshotCommand("frobnicate")).toThrow();
    expect(() => parseSnapshotCommand("save --bogus")).toThrow();
    expect(() => parseSnapshotCommand("list --force")).toThrow();
    expect(() => parseSnapshotCommand("load --force")).toThrow();
    expect(() => parseSnapshotCommand("list baseline")).toThrow();
    expect(() => parseSnapshotCommand("save a b")).toThrow();
    expect(() => parseSnapshotCommand("save --force --force x")).toThrow();
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

describe("completeSnapshotActions", () => {
  it("offers every top-level action for an empty prefix", () => {
    expect(
      completeSnapshotActions("")
        ?.map((item) => item.value)
        .sort(),
    ).toEqual(["delete", "list", "load", "save"]);
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
    expect(completeSnapshotActions("save baseline")).toBeNull();
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
    piSessionSnapshot({
      registerCommand(commandName: string) {
        commands.push(commandName);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      on(event: string, handler: unknown) {
        handlers[event] = handler;
      },
    } as never);

    expect(commands).toEqual(["snapshot"]);
    expect(tools).toEqual([]);
    expect(handlers).toHaveProperty("session_start");
    expect(handlers).toHaveProperty("agent_start");
    expect(handlers).toHaveProperty("session_shutdown");
  });
});
