import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotError } from "../src/errors.js";
import {
  deleteSnapshot,
  forkSnapshot,
  listSnapshots,
  saveSnapshot,
} from "../src/snapshots.js";
import {
  appendAssistant,
  appendUser,
  cleanupTempDirectories,
  makeSessionDirectories,
  messageText,
} from "./helpers.js";

afterEach(cleanupTempDirectories);

function messageTexts(manager: SessionManager): string[] {
  return manager
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => messageText(entry) ?? "")
    .filter((text) => text.length > 0);
}

function persistedSession(cwd: string, sessionDir: string): SessionManager {
  const session = SessionManager.create(cwd, sessionDir);
  return session;
}

describe("saveSnapshot", () => {
  it("rejects an unpersisted source session", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    expect(() =>
      saveSnapshot(
        {
          snapshotDir,
          name: "baseline",
          sourceSessionFile: join(sessions, "missing.jsonl"),
          leafId: "nope",
        },
        {},
      ),
    ).toThrowError(SnapshotError);
  });

  it("saves a linear active path and keeps the source unchanged", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "root reply");

    const result = saveSnapshot({
      snapshotDir,
      name: "baseline",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });

    expect(existsSync(result.file)).toBe(true);
    expect(result.name).toBe("baseline");
    if (process.platform !== "win32") {
      expect(statSync(result.file).mode & 0o777).toBe(0o600);
    }

    const snapshot = SessionManager.open(result.file);
    expect(messageTexts(snapshot)).toEqual(["root", "root reply"]);
    expect(snapshot.getHeader()?.parentSession).toBe(session.getSessionFile());
    // No leftover generated timestamp/uuid files beside the named snapshot.
    expect(listSnapshots(snapshotDir)).toHaveLength(1);
    // Source session is untouched.
    expect(
      messageTexts(SessionManager.open(session.getSessionFile()!)),
    ).toEqual(["root", "root reply"]);
  });

  it("saves only the selected root-to-leaf path of a branched session", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "root reply");
    const rootReplyId = session.getLeafId()!;

    // Alternate branch from the root reply.
    session.branch(rootReplyId);
    appendUser(session, "alternate");
    appendAssistant(session, "alt reply");

    // Selected branch from the root reply.
    session.branch(rootReplyId);
    appendUser(session, "selected");
    appendAssistant(session, "selected reply");
    const selectedLeaf = session.getLeafId()!;

    const result = saveSnapshot({
      snapshotDir,
      name: "selected",
      sourceSessionFile: session.getSessionFile()!,
      leafId: selectedLeaf,
    });

    const snapshot = SessionManager.open(result.file);
    const texts = messageTexts(snapshot);
    expect(texts).toEqual(["root", "root reply", "selected", "selected reply"]);
    expect(texts).not.toContain("alternate");
    expect(texts).not.toContain("alt reply");

    // The source still contains both branches.
    const sourceTexts = messageTexts(
      SessionManager.open(session.getSessionFile()!),
    );
    expect(sourceTexts).toContain("alt reply");
    expect(sourceTexts).toContain("selected reply");
  });

  it("retains active-path session metadata and labels", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    const rootId = appendUser(session, "root");
    appendAssistant(session, "root reply");
    const modelChangeId = session.appendModelChange("test", "next-model");
    const customId = session.appendCustomEntry("example", { enabled: true });
    const checkpointId = appendUser(session, "checkpoint");
    session.appendLabelChange(checkpointId, "keep this");
    appendAssistant(session, "checkpoint reply");

    const result = saveSnapshot({
      snapshotDir,
      name: "metadata",
      sourceSessionFile: session.getSessionFile()!,
      leafId: session.getLeafId()!,
    });
    const snapshot = SessionManager.open(result.file);
    const ids = new Set(snapshot.getEntries().map((entry) => entry.id));

    expect(ids).toContain(rootId);
    expect(ids).toContain(modelChangeId);
    expect(ids).toContain(customId);
    expect(snapshot.getLabel(checkpointId)).toBe("keep this");
  });

  it("refuses an existing name by default and replaces only when requested", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    appendUser(session, "first");
    appendAssistant(session, "first reply");

    const source = session.getSessionFile()!;
    const leaf = session.getLeafId()!;

    saveSnapshot({
      snapshotDir,
      name: "baseline",
      sourceSessionFile: source,
      leafId: leaf,
    });

    expect(() =>
      saveSnapshot({
        snapshotDir,
        name: "baseline",
        sourceSessionFile: source,
        leafId: leaf,
      }),
    ).toThrowError(SnapshotError);

    // Update the active path so the replacement has different content.
    appendUser(session, "second");
    appendAssistant(session, "second reply");
    saveSnapshot(
      {
        snapshotDir,
        name: "baseline",
        sourceSessionFile: source,
        leafId: session.getLeafId()!,
      },
      { replace: true },
    );

    const snapshot = SessionManager.open(join(snapshotDir, "baseline.jsonl"));
    expect(messageTexts(snapshot)).toEqual([
      "first",
      "first reply",
      "second",
      "second reply",
    ]);
  });
});

describe("listSnapshots", () => {
  it("returns an empty list when the directory does not exist", () => {
    const { agent } = makeSessionDirectories();
    expect(listSnapshots(join(agent, "pi-session-snapshot"))).toEqual([]);
  });

  it("lists snapshots sorted by name", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    appendUser(session, "x");
    appendAssistant(session, "x reply");
    const source = session.getSessionFile()!;
    const leaf = session.getLeafId()!;

    saveSnapshot({
      snapshotDir,
      name: "zeta",
      sourceSessionFile: source,
      leafId: leaf,
    });
    saveSnapshot({
      snapshotDir,
      name: "alpha",
      sourceSessionFile: source,
      leafId: leaf,
    });

    const names = listSnapshots(snapshotDir).map((entry) => entry.name);
    expect(names).toEqual(["alpha", "zeta"]);
  });
});

describe("deleteSnapshot", () => {
  it("deletes an existing snapshot and reports missing snapshots", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const session = persistedSession(cwd, sessions);
    appendUser(session, "x");
    appendAssistant(session, "x reply");
    const source = session.getSessionFile()!;
    const leaf = session.getLeafId()!;

    const { file } = saveSnapshot({
      snapshotDir,
      name: "baseline",
      sourceSessionFile: source,
      leafId: leaf,
    });

    deleteSnapshot(snapshotDir, "baseline");
    expect(existsSync(file)).toBe(false);
    expect(() => deleteSnapshot(snapshotDir, "baseline")).toThrowError(
      SnapshotError,
    );
  });
});

describe("forkSnapshot", () => {
  it("forks a snapshot into the target cwd and session directory", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    const targetCwd = join(makeSessionDirectories().root, "other-project");
    const targetSessions = makeSessionDirectories().sessions;

    const session = persistedSession(cwd, sessions);
    appendUser(session, "root");
    appendAssistant(session, "root reply");
    const source = session.getSessionFile()!;
    const leaf = session.getLeafId()!;
    const snapshot = saveSnapshot({
      snapshotDir,
      name: "baseline",
      sourceSessionFile: source,
      leafId: leaf,
    });

    const before = readFileSync(snapshot.file, "utf8");
    const fork = forkSnapshot({
      snapshotDir,
      name: "baseline",
      targetCwd,
      targetSessionDir: targetSessions,
    });

    expect(existsSync(fork.destinationFile)).toBe(true);
    expect(fork.destinationFile).not.toBe(snapshot.file);
    expect(fork.snapshotFile).toBe(snapshot.file);

    const manager = SessionManager.open(fork.destinationFile);
    expect(manager.getHeader()?.cwd).toBe(targetCwd);
    expect(manager.getHeader()?.parentSession).toBe(fork.snapshotFile);
    expect(messageTexts(manager)).toEqual(["root", "root reply"]);

    // Snapshot file is unchanged after forking.
    expect(readFileSync(snapshot.file, "utf8")).toBe(before);
  });

  it("rejects a missing snapshot", () => {
    const { agent } = makeSessionDirectories();
    expect(() =>
      forkSnapshot({
        snapshotDir: join(agent, "pi-session-snapshot"),
        name: "missing",
        targetCwd: "/tmp",
        targetSessionDir: "/tmp",
      }),
    ).toThrowError(SnapshotError);
  });

  it("rejects an empty snapshot as invalid without forking it", () => {
    const { cwd, sessions, agent } = makeSessionDirectories();
    const snapshotDir = join(agent, "pi-session-snapshot");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, "invalid.jsonl"), "");

    try {
      forkSnapshot({
        snapshotDir,
        name: "invalid",
        targetCwd: cwd,
        targetSessionDir: sessions,
      });
      throw new Error("Expected invalid snapshot rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotError);
      expect((error as SnapshotError).code).toBe("SNAPSHOT_INVALID");
    }
  });
});
