import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveSnapshot as coreSaveSnapshot,
  type SnapshotEntry,
} from "../src/snapshots.js";
import type { SnapshotPaths } from "../src/paths.js";
import {
  createFlowContext,
  type ActionKind,
  type ActionMenuResult,
  type CollisionChoice,
  type FlowContext,
  type PickedSnapshot,
  type SnapshotUI,
  runInteractiveMenu,
  runSaveFlow,
  runDeleteFlow,
  runLoadFlow,
} from "../src/ui/flow.js";
import {
  appendAssistant,
  appendUser,
  cleanupTempDirectories,
  makeSessionDirectories,
} from "./helpers.js";

afterEach(cleanupTempDirectories);

interface FakeUIOptions {
  actions?: ActionMenuResult[];
  inputs?: (string | null)[];
  picks?: (PickedSnapshot | null)[];
  replacements?: CollisionChoice[];
  deletes?: boolean[];
}

class FakeUI implements SnapshotUI {
  private actions: ActionMenuResult[];
  private inputs: (string | null)[];
  private picks: (PickedSnapshot | null)[];
  private replacements: CollisionChoice[];
  private deletes: boolean[];
  readonly inputCalls: Array<{ initial: string }> = [];
  readonly pickCalls: Array<{ items: SnapshotEntry[]; initialIndex: number }> =
    [];
  readonly replaceCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  readonly listCalls: SnapshotEntry[][] = [];
  readonly notifications: Array<{ message: string; type?: string }> = [];

  constructor(options: FakeUIOptions = {}) {
    this.actions = [...(options.actions ?? [])];
    this.inputs = [...(options.inputs ?? [])];
    this.picks = [...(options.picks ?? [])];
    this.replacements = [...(options.replacements ?? [])];
    this.deletes = [...(options.deletes ?? [])];
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }

  async selectAction(initialIndex: number): Promise<ActionMenuResult> {
    return this.actions.shift() ?? { kind: "cancel", index: initialIndex };
  }

  async inputName(
    _title: string,
    initial: string,
    _placeholder?: string,
  ): Promise<string | null> {
    this.inputCalls.push({ initial });
    return this.inputs.shift() ?? null;
  }

  async pickSnapshot(
    _title: string,
    items: SnapshotEntry[],
    initialIndex: number,
  ): Promise<PickedSnapshot | null> {
    this.pickCalls.push({ items, initialIndex });
    return this.picks.shift() ?? null;
  }

  async confirmReplacement(name: string): Promise<CollisionChoice> {
    this.replaceCalls.push(name);
    return this.replacements.shift() ?? "cancel";
  }

  async confirmDelete(name: string): Promise<boolean> {
    this.deleteCalls.push(name);
    return this.deletes.shift() ?? false;
  }

  async showList(items: SnapshotEntry[]): Promise<void> {
    this.listCalls.push(items);
  }
}

function setupSessionAndPaths(): {
  paths: SnapshotPaths;
  flowCtx: FlowContext;
  session: SessionManager;
} {
  const { cwd, sessions, agent } = makeSessionDirectories();
  const snapshotDir = join(agent, "pi-session-snapshot");
  const session = SessionManager.create(cwd, sessions);
  appendUser(session, "root");
  appendAssistant(session, "root reply");
  const paths: SnapshotPaths = { agentDir: agent, snapshotDir };
  const flowCtx = {
    hasUI: true,
    cwd,
    sessionManager: session,
    async waitForIdle() {},
    async switchSession(
      _sessionPath: string,
      _options?: { withSession?: (ctx: unknown) => Promise<void> | void },
    ): Promise<{ cancelled: boolean }> {
      return { cancelled: false };
    },
  };
  return { paths, flowCtx, session };
}

describe("interactive menu navigation", () => {
  it("returns to the top menu after canceling the action menu", async () => {
    const { paths, flowCtx } = setupSessionAndPaths();
    const ui = new FakeUI({ actions: [{ kind: "cancel", index: 0 }] });
    await runInteractiveMenu(flowCtx, paths, ui);
    expect(ui.notifications).toEqual([]);
  });

  it("opens the save-name input from the action menu", async () => {
    const { paths, flowCtx } = setupSessionAndPaths();
    const ui = new FakeUI({
      actions: [
        { kind: "save", index: 0 },
        { kind: "cancel", index: 1 },
      ],
      inputs: [null],
    });
    await runInteractiveMenu(flowCtx, paths, ui);
    expect(ui.inputCalls).toEqual([{ initial: "" }]);
  });
});

describe("save collision behavior", () => {
  it("canceling a collision preserves the entered name and re-prompts", async () => {
    const { paths, flowCtx, session } = setupSessionAndPaths();
    coreSaveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const ui = new FakeUI({
      inputs: ["baseline", "renamed"],
      replacements: ["cancel"],
    });

    await runSaveFlow(flowCtx, paths, ui, undefined, false);

    expect(ui.inputCalls[0]).toEqual({ initial: "" });
    expect(ui.inputCalls[1]).toEqual({ initial: "baseline" });
    expect(ui.replaceCalls).toEqual(["baseline"]);
    expect(existsSync(join(paths.snapshotDir, "renamed.jsonl"))).toBe(true);
  });

  it("choosing save-as-another-name preserves the name and re-prompts", async () => {
    const { paths, flowCtx, session } = setupSessionAndPaths();
    coreSaveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const ui = new FakeUI({
      inputs: ["baseline", "renamed"],
      replacements: ["rename"],
    });

    await runSaveFlow(flowCtx, paths, ui, undefined, false);

    expect(ui.inputCalls[1]).toEqual({ initial: "baseline" });
    expect(existsSync(join(paths.snapshotDir, "renamed.jsonl"))).toBe(true);
  });

  it("choosing replace overwrites the existing snapshot", async () => {
    const { paths, flowCtx, session } = setupSessionAndPaths();
    appendUser(session, "second");
    appendAssistant(session, "second reply");
    coreSaveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    // Revert content to the shorter path to prove replacement differs.
    session.branch(session.getEntries()[0]!.id);
    appendAssistant(session, "short reply");
    const ui = new FakeUI({
      inputs: ["baseline"],
      replacements: ["replace"],
    });

    await runSaveFlow(flowCtx, paths, ui, undefined, false);

    expect(ui.replaceCalls).toEqual(["baseline"]);
    const snapshots = ui.listCalls;
    expect(snapshots.length).toBe(0);
    expect(existsSync(join(paths.snapshotDir, "baseline.jsonl"))).toBe(true);
  });

  it("rejects an invalid name and re-prompts with the value preserved", async () => {
    const { paths, flowCtx } = setupSessionAndPaths();
    const ui = new FakeUI({
      inputs: ["has space", "valid"],
    });

    await runSaveFlow(flowCtx, paths, ui, undefined, false);

    expect(ui.inputCalls[0]).toEqual({ initial: "" });
    expect(ui.inputCalls[1]).toEqual({ initial: "has space" });
    expect(existsSync(join(paths.snapshotDir, "valid.jsonl"))).toBe(true);
  });
});

describe("load flow", () => {
  it("forks and notifies on a successful picker selection", async () => {
    const { paths, flowCtx, session } = setupSessionAndPaths();
    coreSaveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const ui = new FakeUI({
      picks: [
        {
          entry: {
            name: "baseline",
            file: join(paths.snapshotDir, "baseline.jsonl"),
            bytes: 1,
            modifiedMs: 0,
          },
          index: 0,
        },
      ],
    });

    const replacementNotifications: Array<{ message: string; type?: string }> =
      [];
    const successfulFlowCtx: FlowContext = {
      ...flowCtx,
      async switchSession(_sessionPath, options) {
        await options?.withSession?.({
          ui: {
            notify(message: string, type?: string) {
              replacementNotifications.push({ message, type });
            },
          },
        });
        return { cancelled: false };
      },
    };

    await runLoadFlow(successfulFlowCtx, paths, ui, undefined);

    expect(ui.pickCalls).toHaveLength(1);
    expect(replacementNotifications[0]?.message).toContain(
      'Loaded session snapshot "baseline"',
    );
  });

  it("removes the just-created fork when the switch is cancelled", async () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    sessions;
    const target = SessionManager.create(cwd, sessions);
    appendUser(target, "root");
    appendAssistant(target, "root reply");
    const snapshotDir = join(agent, "pi-session-snapshot");
    const paths: SnapshotPaths = { agentDir: agent, snapshotDir };
    coreSaveSnapshot({
      snapshotDir,
      name: "baseline",
      sourceSessionFile: target.getSessionFile()!,
      leafId: target.getLeafId()!,
    });

    let createdFile: string | undefined;
    const flowCtx: FlowContext = {
      hasUI: true,
      cwd,
      sessionManager: target,
      async waitForIdle() {},
      async switchSession(sessionPath) {
        createdFile = sessionPath;
        return { cancelled: true };
      },
    };
    const ui = new FakeUI({
      picks: [
        {
          entry: {
            name: "baseline",
            file: join(snapshotDir, "baseline.jsonl"),
            bytes: 1,
            modifiedMs: 0,
          },
          index: 0,
        },
      ],
    });

    await runLoadFlow(flowCtx, paths, ui, undefined);

    expect(createdFile).toBeDefined();
    expect(existsSync(createdFile!)).toBe(false);
    expect(ui.notifications[0]?.type).toBe("warning");
  });
});

describe("delete flow", () => {
  it("cancelling confirmation returns to the picker without deleting", async () => {
    const { paths, flowCtx, session } = setupSessionAndPaths();
    coreSaveSnapshot({
      snapshotDir: paths.snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const entry = {
      name: "baseline",
      file: join(paths.snapshotDir, "baseline.jsonl"),
      bytes: 1,
      modifiedMs: 0,
    };
    const cancelledUI = new FakeUI({
      picks: [{ entry, index: 0 }, null],
      deletes: [false],
    });

    await runDeleteFlow(flowCtx, paths, cancelledUI, undefined, false);

    expect(existsSync(entry.file)).toBe(true);
    // Cancel returns to the same snapshot list position before Escape exits.
    expect(cancelledUI.pickCalls[1]?.initialIndex).toBe(0);

    const confirmedUI = new FakeUI({
      picks: [{ entry, index: 0 }],
      deletes: [true],
    });
    await runDeleteFlow(flowCtx, paths, confirmedUI, undefined, false);
    expect(existsSync(entry.file)).toBe(false);
  });
});

describe("FlowContext adapter", () => {
  it("preserves hasUI, cwd, session manager, and switchSession delegation", async () => {
    const { flowCtx, session } = setupSessionAndPaths();
    const adapted = createFlowContext({
      hasUI: flowCtx.hasUI,
      cwd: flowCtx.cwd,
      sessionManager: session,
      waitForIdle: flowCtx.waitForIdle!,
      switchSession: flowCtx.switchSession!,
    });
    expect(adapted.hasUI).toBe(true);
    expect(adapted.cwd).toBe(flowCtx.cwd);
    expect(adapted.sessionManager).toBe(session);
    expect(typeof adapted.switchSession).toBe("function");
  });
});
