import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatSnapshotError } from "./errors.js";
import {
	productionSnapshotPaths,
	type SnapshotPaths,
} from "./paths.js";
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
			`Unknown action "/snapshot ${action}". Usage: /snapshot [save|load|list|delete] [name] [--force].`,
		);
	}

	if (action === "list" && rest.length > 0) {
		throw new InvalidArgument("/snapshot list does not accept a name or flags.");
	}

	const allowForce = action === "save" || action === "delete";
	let name: string | undefined;
	let force = false;
	let seenName = false;

	for (const token of rest) {
		if (token === "--force") {
			if (!allowForce) {
				throw new InvalidArgument(
					`--force is not valid for "/snapshot ${action}".`,
				);
			}
			if (force) {
				throw new InvalidArgument("Duplicate --force flag.");
			}
			force = true;
			continue;
		}
		if (token.startsWith("--")) {
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
							"UI_UNAVAILABLE: /snapshot requires TUI mode. Use /snapshot [save|load|list|delete] [name] [--force].",
							"error",
						);
						return;
					}
					await runInteractiveMenu(flowCtx, paths, ui as SnapshotUI);
					return;
				case "save":
					await runSaveFlow(flowCtx, paths, ui as SnapshotUI, parsed.name, parsed.force);
					return;
				case "load":
					await runLoadFlow(flowCtx, paths, ui as SnapshotUI, parsed.name);
					return;
				case "list":
					await runListFlow(flowCtx, paths, ui as SnapshotUI);
					return;
				case "delete":
					await runDeleteFlow(flowCtx, paths, ui as SnapshotUI, parsed.name, parsed.force);
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