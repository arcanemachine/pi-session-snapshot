import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatPermissionStatus,
  permissionGuidance,
  refreshConfiguration,
  resolvePermission,
  setOverride,
  type AgentAction,
} from "./authorization.js";
import {
  runPendingRestore,
  runPendingSave,
  type SnapshotAgentBridge,
} from "./agent.js";
import { formatSnapshotError } from "./errors.js";
import { productionSnapshotPaths, type SnapshotPaths } from "./paths.js";
import {
  runDeleteFlow,
  runInteractiveMenu,
  runListFlow,
  runLoadFlow,
  runSaveFlow,
  SNAPSHOT_COMMAND_DESCRIPTION,
  type FlowContext,
  type SnapshotUI,
} from "./ui/flow.js";
import { createSnapshotUI } from "./ui/components.js";

const ACTIONS = new Set(["save", "load", "list", "delete"]);
const AGENT_TARGETS = new Set(["save", "restore", "all"]);
const AGENT_DECISIONS = new Set(["allow", "deny", "reset"]);

const FORCE_FLAGS = new Set(["--force", "-f"]);

const ACTION_COMPLETIONS: { value: string; label: string }[] = [
  {
    value: "save",
    label: "save — Save the active session path as a named snapshot",
  },
  {
    value: "load",
    label: "load — Restore a named snapshot by forking a new session",
  },
  {
    value: "list",
    label: "list — List saved snapshots",
  },
  { value: "delete", label: "delete — Delete a named snapshot" },
];

/**
 * Top-level `/snapshot` argument completions. Only the first token (the
 * action) is completed; once the user moves into the name argument the prefix
 * no longer matches any action and completions fall silent.
 */
export function completeSnapshotActions(
  argumentPrefix: string,
): { value: string; label: string }[] | null {
  // The completion value replaces the full argument prefix, so flag
  // completions must keep the action and name tokens.
  const flagMatch = /^(save|delete)(\s+\S+)?\s+(-{1,2}\S*)$/.exec(
    argumentPrefix,
  );
  if (flagMatch) {
    const [, action, name, flag] = flagMatch;
    const flags = ["--force", "-f"].filter((candidate) =>
      candidate.startsWith(flag),
    );
    const descriptions: Record<string, string> = {
      "--force": "Overwrite or delete without confirmation",
      "-f": "Shorthand for --force",
    };
    return flags.length === 0
      ? null
      : flags.map((candidate) => ({
          value: `${action}${name ?? ""} ${candidate}`,
          label: candidate,
          description: descriptions[candidate],
        }));
  }

  if (argumentPrefix === "agent" || argumentPrefix.startsWith("agent ")) {
    const rest = argumentPrefix.slice("agent".length).trimStart();
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return [
        { value: "agent status", label: "status" },
        { value: "agent save", label: "save" },
        { value: "agent restore", label: "restore" },
        { value: "agent all", label: "all" },
      ];
    }
    if (tokens.length === 1) {
      const prefix = tokens[0]!;
      if (prefix === "status") return null;
      if (AGENT_TARGETS.has(prefix)) {
        return ["allow", "deny", "reset"].map((decision) => ({
          value: `agent ${prefix} ${decision}`,
          label: decision,
        }));
      }
      const targets = ["status", "save", "restore", "all"].filter((target) =>
        target.startsWith(prefix),
      );
      return targets.length === 0
        ? null
        : targets.map((target) => ({
            value: `agent ${target}`,
            label: target,
          }));
    }
    if (tokens.length === 2) {
      const [target, decisionPrefix] = tokens;
      if (!AGENT_TARGETS.has(target)) return null;
      if (AGENT_DECISIONS.has(decisionPrefix!)) return null;
      const decisions = ["allow", "deny", "reset"].filter((decision) =>
        decision.startsWith(decisionPrefix),
      );
      return decisions.length === 0
        ? null
        : decisions.map((decision) => ({
            value: `agent ${target} ${decision}`,
            label: decision,
          }));
    }
    return null;
  }

  const matches = ACTION_COMPLETIONS.filter((item) =>
    item.value.startsWith(argumentPrefix),
  );
  if (argumentPrefix === "" || "agent".startsWith(argumentPrefix)) {
    matches.push({
      value: "agent",
      label: "agent — Configure agent snapshot tools",
    });
  }
  return matches.length === 0 ? null : matches;
}

export interface ParsedCommand {
  action:
    | "interactive"
    | "save"
    | "load"
    | "list"
    | "delete"
    | "agent"
    | "agent-save"
    | "agent-restore";
  name?: string;
  force: boolean;
  agentTarget?: "save" | "restore" | "all";
  agentDecision?: "allow" | "deny" | "reset" | "status";
  token?: string;
}

export function parseSnapshotCommand(args: string): ParsedCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "interactive", force: false };

  const [action, ...rest] = tokens;
  if (action === "agent") {
    if (rest.length === 1 && rest[0] === "status") {
      return {
        action: "agent",
        agentDecision: "status",
        force: false,
      };
    }
    if (
      rest.length === 2 &&
      AGENT_TARGETS.has(rest[0]!) &&
      AGENT_DECISIONS.has(rest[1]!)
    ) {
      return {
        action: "agent",
        agentTarget: rest[0] as "save" | "restore" | "all",
        agentDecision: rest[1] as "allow" | "deny" | "reset",
        force: false,
      };
    }
    throw new InvalidArgument(
      "Usage: /snapshot agent status | /snapshot agent [save|restore|all] [allow|deny|reset].",
    );
  }
  if (action === "agent-save" || action === "agent-restore") {
    if (rest.length !== 1 || !rest[0]) {
      throw new InvalidArgument("Internal snapshot agent request is invalid.");
    }
    return { action, token: rest[0], force: false };
  }
  if (!ACTIONS.has(action)) {
    throw new InvalidArgument(
      `Unknown action "/snapshot ${action}". Usage: /snapshot [save|load|list|delete] [name] [--force|-f].`,
    );
  }

  if (action === "list" && rest.length > 0) {
    throw new InvalidArgument(
      "/snapshot list does not accept a name or flags.",
    );
  }

  const allowForce = action === "save" || action === "delete";
  let name: string | undefined;
  let force = false;
  let seenName = false;

  for (const token of rest) {
    if (FORCE_FLAGS.has(token)) {
      if (!allowForce) {
        throw new InvalidArgument(
          `--force is not valid for "/snapshot ${action}".`,
        );
      }
      if (force) {
        throw new InvalidArgument(
          "Duplicate --force flag; --force and -f cannot be combined.",
        );
      }
      force = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      throw new InvalidArgument(`Unknown flag "${token}".`);
    }
    if (seenName) {
      throw new InvalidArgument(
        `Unexpected extra argument "${token}" for "/snapshot ${action}".`,
      );
    }
    seenName = true;
    name = token;
  }

  return { action, name, force } as ParsedCommand;
}

class InvalidArgument extends Error {
  readonly code = "INVALID_ARGUMENT" as const;
}

export type SnapshotCommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

export function createSnapshotCommandHandler(
  pathsProvider: () => SnapshotPaths = productionSnapshotPaths,
  bridge?: SnapshotAgentBridge,
): SnapshotCommandHandler {
  return async (args, ctx) => {
    let parsed: ParsedCommand;
    try {
      parsed = parseSnapshotCommand(args);
    } catch (error) {
      ctx.ui.notify(String((error as Error).message), "warning");
      return;
    }
    const paths = pathsProvider();
    if (parsed.action === "agent") {
      refreshConfiguration(ctx);
      if (parsed.agentDecision === "status") {
        ctx.ui.notify(
          [
            "Agent snapshot permissions:",
            `  ${formatPermissionStatus("save")}`,
            `  ${formatPermissionStatus("restore")}`,
          ].join("\n"),
          "info",
        );
        return;
      }
      const actions: AgentAction[] =
        parsed.agentTarget === "all"
          ? ["save", "restore"]
          : [parsed.agentTarget!];
      const override =
        parsed.agentDecision === "allow"
          ? true
          : parsed.agentDecision === "deny"
            ? false
            : null;
      for (const action of actions) setOverride(action, override);
      ctx.ui.notify(
        override === null
          ? `Agent snapshot ${actions.join(" and ")} permission reset to configuration.`
          : `Agent snapshot ${actions.join(" and ")} permission ${override ? "allowed" : "denied"} for this Pi process.`,
        "info",
      );
      return;
    }
    if (parsed.action === "agent-save") {
      if (!bridge) {
        ctx.ui.notify(
          "SNAPSHOT_CREATE_FAILED: No agent save bridge is available.",
          "error",
        );
        return;
      }
      const pending = bridge.consumeSave(parsed.token!, ctx);
      if (!pending) {
        ctx.ui.notify(
          "SNAPSHOT_CREATE_FAILED: The queued agent save request is stale or missing.",
          "warning",
        );
        return;
      }
      if (!resolvePermission("save").allowed) {
        ctx.ui.notify(permissionGuidance("save"), "warning");
        return;
      }
      try {
        await runPendingSave(pending, adaptContext(ctx), paths, ctx.ui);
      } catch (error) {
        ctx.ui.notify(formatSnapshotError(error), "error");
      }
      return;
    }
    if (parsed.action === "agent-restore") {
      if (!bridge) {
        ctx.ui.notify(
          "SNAPSHOT_LOAD_FAILED: No agent restore bridge is available.",
          "error",
        );
        return;
      }
      const pending = bridge.consumeRestore(parsed.token!, ctx);
      if (!pending) {
        ctx.ui.notify(
          "SNAPSHOT_LOAD_FAILED: The queued agent restore request is stale or missing.",
          "warning",
        );
        return;
      }
      if (!resolvePermission("restore").allowed) {
        ctx.ui.notify(permissionGuidance("restore"), "warning");
        return;
      }
      try {
        await runPendingRestore(pending, adaptContext(ctx), paths, ctx.ui);
      } catch (error) {
        ctx.ui.notify(formatSnapshotError(error), "error");
      }
      return;
    }

    const ui = createSnapshotUI(ctx);
    const flowCtx = adaptContext(ctx);
    try {
      switch (parsed.action) {
        case "interactive":
          if (!ctx.hasUI) {
            ctx.ui.notify(
              "UI_UNAVAILABLE: /snapshot requires TUI mode. Use /snapshot [save|load|list|delete] [name] [--force|-f].",
              "error",
            );
            return;
          }
          await runInteractiveMenu(flowCtx, paths, ui as SnapshotUI);
          return;
        case "save":
          await runSaveFlow(
            flowCtx,
            paths,
            ui as SnapshotUI,
            parsed.name,
            parsed.force,
          );
          return;
        case "load":
          await runLoadFlow(flowCtx, paths, ui as SnapshotUI, parsed.name);
          return;
        case "list":
          await runListFlow(flowCtx, paths, ui as SnapshotUI);
          return;
        case "delete":
          await runDeleteFlow(
            flowCtx,
            paths,
            ui as SnapshotUI,
            parsed.name,
            parsed.force,
          );
          return;
      }
    } catch (error) {
      ctx.ui.notify(formatSnapshotError(error), "error");
    }
  };
}

export function registerSnapshotCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  pathsProvider?: () => SnapshotPaths,
  bridge?: SnapshotAgentBridge,
): void {
  pi.registerCommand("snapshot", {
    description: SNAPSHOT_COMMAND_DESCRIPTION,
    getArgumentCompletions: completeSnapshotActions,
    handler: createSnapshotCommandHandler(pathsProvider, bridge),
  });
}

function adaptContext(ctx: ExtensionCommandContext): FlowContext {
  return {
    hasUI: ctx.hasUI,
    cwd: ctx.cwd,
    sessionManager: ctx.sessionManager,
    waitForIdle: () => ctx.waitForIdle(),
    switchSession: (sessionPath, options) =>
      ctx.switchSession(sessionPath, {
        withSession: options?.withSession
          ? (replacement) => Promise.resolve(options.withSession!(replacement))
          : undefined,
      }),
  };
}
