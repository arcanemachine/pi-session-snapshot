import type {
  ExtensionAPI,
  ExtensionContext,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { registerSnapshotCommand } from "./command.js";
import { productionSnapshotPaths } from "./paths.js";
import { ProvisionalTracker, type ShutdownReason } from "./provisional.js";

export default function piSessionSnapshot(pi: ExtensionAPI): void {
  const paths = productionSnapshotPaths();
  registerSnapshotCommand(pi, () => paths);

  const tracker = new ProvisionalTracker(paths.snapshotDir, (file) => {
    try {
      return SessionManager.open(file)
        .getEntries()
        .map((entry) => entry.id);
    } catch {
      return undefined;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    tracker.start(provisionalInput(ctx));
  });

  pi.on("agent_start", (_event, ctx) => {
    tracker.markUsed(ctx.sessionManager.getSessionFile());
  });

  pi.on("session_shutdown", (event, ctx) => {
    const file = tracker.finalize(
      provisionalInput(ctx),
      event.reason as ShutdownReason,
    );
    if (!file) return;
    if (!ctx.sessionManager.getSessionFile()) return;
    try {
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // best-effort; report nothing during shutdown
    }
  });
}

function provisionalInput(ctx: ExtensionContext): {
  sessionFile: string | undefined;
  parentSession: string | undefined;
  entryIds: string[];
} {
  const manager = ctx.sessionManager;
  const sessionFile = manager.getSessionFile();
  const header = manager.getHeader() as
    | (SessionHeader & { parentSession?: string })
    | null;
  return {
    sessionFile,
    parentSession: header?.parentSession,
    entryIds: manager.getEntries().map((entry) => entry.id),
  };
}
