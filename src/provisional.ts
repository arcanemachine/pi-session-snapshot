import { basename, dirname, resolve } from "node:path";
import { nameFromSnapshotFilename } from "./names.js";

export interface ProvisionalBaselineProvider {
	/**
	 * Return the entry ids stored in a snapshot file, used as the baseline for
	 * deciding whether a restored session has received new activity.
	 * Implementations should return undefined when the parent cannot be read.
	 */
	(sessionFilePath: string): string[] | undefined;
}

export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SessionSnapshotInput {
	/** Active session file path (may be undefined for in-memory sessions). */
	sessionFile: string | undefined;
	/** `parentSession` from the active session header. */
	parentSession: string | undefined;
	/** Entry ids currently stored in the active session. */
	entryIds: string[];
}

/**
 * Tracks whether the active Pi session is a restored fork of a session
 * snapshot, and removes the otherwise-unused fork file on a graceful
 * lifecycle transition.
 *
 * A session is provisional when its `parentSession` points directly at a
 * named JSONL file inside the configured snapshot directory. A restored fork
 * keeps the snapshot's original entry ids, so any new entry id not present in
 * the baseline means the fork has been used and must be retained.
 *
 * The tracker is reconstructible: it reapplies baseline derivation from the
 * snapshot file on every `start`, so it survives reload without relying on
 * module-scoped memory for correctness.
 */
export class ProvisionalTracker {
	private readonly snapshotDir: string;
	private readonly readBaseline: ProvisionalBaselineProvider;

	private activeFile?: string;
	private baselineIds?: Set<string>;
	private used = false;

	constructor(snapshotDir: string, readBaseline: ProvisionalBaselineProvider) {
		this.snapshotDir = resolve(snapshotDir);
		this.readBaseline = readBaseline;
	}

	/** Returns true when `path` is a direct .jsonl child of the snapshot dir. */
	isSnapshotParent(path: string | undefined): boolean {
		if (!path) return false;
		const file = resolve(path);
		if (
			dirname(file) !== this.snapshotDir ||
			!file.toLowerCase().endsWith(".jsonl")
		) {
			return false;
		}
		try {
			nameFromSnapshotFilename(basename(file));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Called on `session_start`. Records the active session and, when it is
	 * snapshot-derived, its baseline entry ids.
	 */
	start(input: SessionSnapshotInput): void {
		this.activeFile = input.sessionFile ? resolve(input.sessionFile) : undefined;
		this.used = false;
		this.baselineIds = undefined;
		const parent = input.parentSession;
		if (parent && this.isSnapshotParent(parent)) {
			try {
				const ids = this.readBaseline(parent);
				if (ids) {
					this.baselineIds = new Set(ids);
					this.used = input.entryIds.some((id) => !this.baselineIds!.has(id));
				}
			} catch {
				this.baselineIds = undefined;
			}
		}
	}

	/**
	 * Called on `agent_start`. Marks the tracked provisional session as used
	 * so it is never removed even if its new entries have not yet persisted.
	 */
	markUsed(sessionFile: string | undefined): void {
		if (
			this.activeFile &&
			sessionFile &&
			resolve(sessionFile) === this.activeFile
		) {
			this.used = true;
		}
	}

	/**
	 * Called on `session_shutdown`. Returns the session file to remove when
	 * the outgoing session is an unused restored fork, or null otherwise.
	 *
	 * Reload never triggers removal: the same conversation continues. A used
	 * restored fork (flagged by `agent_start` or containing a new entry id) is
	 * always retained, including when resumed later.
	 */
	finalize(
		input: SessionSnapshotInput,
		reason: ShutdownReason,
	): string | null {
		if (reason === "reload") {
			return null;
		}
		if (!this.activeFile || !this.baselineIds) {
			this.reset();
			return null;
		}
		if (!input.sessionFile || resolve(input.sessionFile) !== this.activeFile) {
			this.reset();
			return null;
		}
		if (!this.isActiveSnapshot(this.activeFile)) {
			this.reset();
			return null;
		}

		let used = this.used;
		if (!used) {
			for (const id of input.entryIds) {
				if (!this.baselineIds.has(id)) {
					used = true;
					break;
				}
			}
		}

		const file = used ? null : this.activeFile;
		this.reset();
		return file;
	}

	private isActiveSnapshot(file: string): boolean {
		// Never remove the parent snapshot file itself, only the restored fork.
		return (
			dirname(file) !== this.snapshotDir &&
			file.toLowerCase().endsWith(".jsonl")
		);
	}

	private reset(): void {
		this.activeFile = undefined;
		this.baselineIds = undefined;
		this.used = false;
	}
}