import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

export interface SnapshotPathsOptions {
  agentDir?: string;
  snapshotDir?: string;
}

export interface SnapshotPaths {
  agentDir: string;
  snapshotDir: string;
}

export function resolveSnapshotPaths(
  options: SnapshotPathsOptions = {},
): SnapshotPaths {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const snapshotDir = resolve(
    options.snapshotDir ?? join(agentDir, "pi-session-snapshot"),
  );
  return { agentDir, snapshotDir };
}

export function productionSnapshotPaths(): SnapshotPaths {
  return resolveSnapshotPaths();
}
