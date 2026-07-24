import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProvisionalTracker } from "../src/provisional.js";

const SNAPSHOT_DIR = resolve("/snap/sessions");
const BASELINE = ["a", "b"];

function makeTracker(
  snapshotDir: string,
  baselines: Record<string, string[] | undefined> = {},
): ProvisionalTracker {
  return new ProvisionalTracker(snapshotDir, (file) => baselines[file]);
}

describe("ProvisionalTracker", () => {
  it("ignores sessions whose parent is outside the snapshot directory", () => {
    const tracker = makeTracker(SNAPSHOT_DIR);
    tracker.start({
      sessionFile: "/sessions/normal.jsonl",
      parentSession: "/sessions/other.jsonl",
      entryIds: BASELINE,
    });
    expect(
      tracker.finalize(
        {
          sessionFile: "/sessions/normal.jsonl",
          parentSession: "/sessions/other.jsonl",
          entryIds: BASELINE,
        },
        "quit",
      ),
    ).toBe(null);
  });

  it("removes an unused restored fork on quit", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: BASELINE,
    });
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: BASELINE,
        },
        "quit",
      ),
    ).toBe(resolve(fork));
  });

  it("never removes during reload", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: BASELINE,
    });
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: BASELINE,
        },
        "reload",
      ),
    ).toBe(null);
    // The tracker must still consider the session provisional afterward.
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: BASELINE,
        },
        "quit",
      ),
    ).toBe(resolve(fork));
  });

  it("retains the restored fork after agent_start", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: BASELINE,
    });
    tracker.markUsed(fork);
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: BASELINE,
        },
        "quit",
      ),
    ).toBe(null);
  });

  it("retains the restored fork when a new entry id appears", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: [...BASELINE, "c"],
    });
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: [...BASELINE, "c"],
        },
        "quit",
      ),
    ).toBe(null);
  });

  it("does not delete a previously used restored session when resumed later", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: [...BASELINE, "c"],
    });
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: [...BASELINE, "c"],
        },
        "quit",
      ),
    ).toBe(null);
  });

  it("ignores an invalid parent snapshot", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: undefined,
    });
    const fork = "/sessions/restored.jsonl";
    tracker.start({
      sessionFile: fork,
      parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
      entryIds: BASELINE,
    });
    expect(
      tracker.finalize(
        {
          sessionFile: fork,
          parentSession: `${SNAPSHOT_DIR}/base.jsonl`,
          entryIds: BASELINE,
        },
        "quit",
      ),
    ).toBe(null);
  });

  it("never removes the parent snapshot file itself", () => {
    const tracker = makeTracker(SNAPSHOT_DIR, {
      [`${SNAPSHOT_DIR}/base.jsonl`]: BASELINE,
    });
    const snapshot = `${SNAPSHOT_DIR}/base.jsonl`;
    tracker.start({
      sessionFile: snapshot,
      parentSession: snapshot,
      entryIds: BASELINE,
    });
    expect(
      tracker.finalize(
        { sessionFile: snapshot, parentSession: snapshot, entryIds: BASELINE },
        "quit",
      ),
    ).toBe(null);
  });
});
