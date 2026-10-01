import type {
  ExtensionAPI,
  ExtensionContext,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, unlinkSync } from "node:fs";
import {
  createSnapshotAgentBridge,
  registerSnapshotTools,
  SNAPSHOT_RESTORE_ENTRY_TYPE,
} from "./agent.js";
import { refreshConfiguration } from "./authorization.js";
import { registerSnapshotCommand } from "./command.js";
import { productionSnapshotPaths } from "./paths.js";
import { ProvisionalTracker, type ShutdownReason } from "./provisional.js";

export default function piSessionSnapshot(pi: ExtensionAPI): void {
  const paths = productionSnapshotPaths();
  const bridge = createSnapshotAgentBridge(pi);
  registerSnapshotCommand(pi, () => paths, bridge);
  registerSnapshotTools(pi, () => paths, bridge);
  pi.registerEntryRenderer(
    SNAPSHOT_RESTORE_ENTRY_TYPE,
    (entry, _options, theme) => {
      const data = entry.data as { name?: string } | undefined;
      return new Text(
        theme.fg(
          "accent",
          `Restored session snapshot "${data?.name ?? "unknown"}".`,
        ),
        0,
        0,
      );
    },
  );

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
    refreshConfiguration(ctx);
    bridge.invalidateForSession(ctx.sessionManager.getSessionId(), ctx.ui);
    tracker.start(provisionalInput(ctx));
  });

  pi.on("turn_end", (_event, ctx) => {
    bridge.observeTurnEnd(ctx);
    if (bridge.shouldStopAfterTurn(ctx)) ctx.abort();
  });

  pi.on("agent_settled", (_event, ctx) => {
    bridge.dispatchAfterSettled(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    tracker.markUsed(ctx.sessionManager.getSessionFile());
  });

  pi.on("session_shutdown", (event, ctx) => {
    bridge.cancelForShutdown(ctx.ui);
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
    entryIds: manager
      .getEntries()
      .filter(
        (entry) =>
          entry.type !== "custom" ||
          entry.customType !== SNAPSHOT_RESTORE_ENTRY_TYPE,
      )
      .map((entry) => entry.id),
  };
}
