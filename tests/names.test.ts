import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotError } from "../src/errors.js";
import {
  nameFromSnapshotFilename,
  normalizeSnapshotName,
  resolveSnapshotFile,
  snapshotFilename,
} from "../src/names.js";
import { resolveSnapshotPaths } from "../src/paths.js";

function expectInvalidName(input: string): void {
  try {
    normalizeSnapshotName(input);
    throw new Error(`Expected ${JSON.stringify(input)} to be rejected`);
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).code).toBe("INVALID_NAME");
  }
}

describe("snapshot names", () => {
  it.each([
    ["baseline", "baseline"],
    [" baseline-v2 ", "baseline-v2"],
    ["research.context", "research.context"],
    ["my_snapshot", "my_snapshot"],
    ["baseline.jsonl", "baseline"],
    ["Baseline.JSONL", "Baseline"],
    ["name.jsonl.jsonl", "name.jsonl"],
    ["a", "a"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSnapshotName(input)).toBe(expected);
    expect(snapshotFilename(input)).toBe(`${expected}.jsonl`);
  });

  it.each([
    "",
    "   ",
    ".",
    "..",
    "../outside",
    "nested/name",
    "nested\\name",
    "/absolute",
    "-leading",
    "trailing-",
    ".hidden",
    "hidden.",
    "has space",
  ])("rejects unsafe name %j", expectInvalidName);

  it("resolves a direct child of the snapshot directory", () => {
    const directory = resolve("/tmp/snapshots");
    expect(resolveSnapshotFile(directory, "baseline")).toBe(
      join(directory, "baseline.jsonl"),
    );
  });

  it("derives names only from JSONL filenames", () => {
    expect(nameFromSnapshotFilename("baseline.jsonl")).toBe("baseline");
    expect(() => nameFromSnapshotFilename("baseline.txt")).toThrowError(
      SnapshotError,
    );
  });
});

describe("snapshot paths", () => {
  it("uses an injected agent directory without consulting production state", () => {
    const paths = resolveSnapshotPaths({ agentDir: "/tmp/test-agent" });
    expect(paths).toEqual({
      agentDir: resolve("/tmp/test-agent"),
      snapshotDir: resolve("/tmp/test-agent/pi-session-snapshot"),
    });
  });

  it("accepts an injected snapshot directory for tests", () => {
    const paths = resolveSnapshotPaths({
      agentDir: "/tmp/test-agent",
      snapshotDir: "/tmp/test-snapshots",
    });
    expect(paths.snapshotDir).toBe(resolve("/tmp/test-snapshots"));
  });
});
