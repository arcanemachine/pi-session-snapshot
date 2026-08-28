import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
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

  const matches = ACTION_COMPLETIONS.filter((item) =>
    item.value.startsWith(argumentPrefix),
  );
  return matches.length === 0 ? null : matches;
}

export interface ParsedCommand {
  action: "interactive" | "save" | "load" | "list" | "delete";
  name?: string;
  force: boolean;
}

export function parseSnapshotCommand(args: string): ParsedCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { action: "interactive", force: false };

  const [action, ...rest] = tokens;
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
): void {
  pi.registerCommand("snapshot", {
    description: SNAPSHOT_COMMAND_DESCRIPTION,
    getArgumentCompletions: completeSnapshotActions,
    handler: createSnapshotCommandHandler(pathsProvider),
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
