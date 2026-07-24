import { dirname, join, resolve } from "node:path";
import { SnapshotError } from "./errors.js";

const SNAPSHOT_SUFFIX = ".jsonl";
const VALID_STEM = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function normalizeSnapshotName(input: string): string {
  let stem = input.trim();
  if (stem.toLowerCase().endsWith(SNAPSHOT_SUFFIX)) {
    stem = stem.slice(0, -SNAPSHOT_SUFFIX.length);
  }

  if (!VALID_STEM.test(stem) || stem === "." || stem === "..") {
    throw new SnapshotError(
      "INVALID_NAME",
      "Snapshot names must start and end with a letter or number and contain only letters, numbers, dots, underscores, or hyphens.",
    );
  }

  return stem;
}

export function snapshotFilename(name: string): string {
  return `${normalizeSnapshotName(name)}${SNAPSHOT_SUFFIX}`;
}

export function resolveSnapshotFile(snapshotDir: string, name: string): string {
  const directory = resolve(snapshotDir);
  const file = resolve(join(directory, snapshotFilename(name)));
  if (dirname(file) !== directory) {
    throw new SnapshotError(
      "INVALID_NAME",
      "Snapshot name must resolve directly inside the snapshot directory.",
    );
  }
  return file;
}

export function nameFromSnapshotFilename(filename: string): string {
  if (!filename.toLowerCase().endsWith(SNAPSHOT_SUFFIX)) {
    throw new SnapshotError("INVALID_NAME", "Snapshot file must end in .jsonl.");
  }
  return normalizeSnapshotName(filename);
}
