import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	lstatSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { SnapshotError } from "./errors.js";
import {
	nameFromSnapshotFilename,
	normalizeSnapshotName,
	resolveSnapshotFile,
} from "./names.js";

const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIR_MODE = 0o700;

export interface SaveSnapshotInput {
	/** Resolved snapshot directory (where named snapshots live). */
	snapshotDir: string;
	/** Raw user-facing snapshot name (validated and normalized). */
	name: string;
	/** Persisted source session file path. */
	sourceSessionFile: string;
	/** Leaf entry id of the active session path. */
	leafId: string;
}

export interface SaveSnapshotResult {
	name: string;
	file: string;
}

export interface SaveSnapshotOptions {
	/** Replace an existing snapshot with the same name. */
	replace?: boolean;
}

export interface SnapshotEntry {
	name: string;
	file: string;
	bytes: number;
	modifiedMs: number;
}

export interface ForkSnapshotInput {
	snapshotDir: string;
	name: string;
	targetCwd: string;
	/** Destination session directory for the new fork. */
	targetSessionDir: string;
}

export interface ForkSnapshotResult {
	destinationFile: string;
	snapshotFile: string;
}

function isPosix(): boolean {
	return process.platform !== "win32";
}

function applyDirectoryMode(path: string): void {
	if (isPosix()) {
		try {
			chmodSync(path, SNAPSHOT_DIR_MODE);
		} catch {
			// best-effort; ownership or FS may not support it
		}
	}
}

function applyFileMode(path: string): void {
	if (isPosix()) {
		try {
			chmodSync(path, SNAPSHOT_FILE_MODE);
		} catch {
			// best-effort
		}
	}
}

function moveIntoPlace(source: string, destination: string): void {
	// POSIX rename replaces the existing destination atomically. On a platform
	// that cannot do that, fail safely and retain the old named snapshot rather
	// than deleting it before the replacement is known to be in place.
	renameSync(source, destination);
}

export function saveSnapshot(
	input: SaveSnapshotInput,
	options: SaveSnapshotOptions = {},
): SaveSnapshotResult {
	const name = normalizeSnapshotName(input.name);
	const snapshotDir = resolveSnapshotDir(input.snapshotDir);
	const destination = resolveSnapshotFile(snapshotDir, input.name);

	if (!existsSync(input.sourceSessionFile)) {
		throw new SnapshotError(
			"SESSION_NOT_PERSISTED",
			"The current session has not been persisted to disk.",
		);
	}

	mkdirSync(snapshotDir, { recursive: true });
	applyDirectoryMode(snapshotDir);

	if (!options.replace && existsSync(destination)) {
		throw new SnapshotError(
			"SNAPSHOT_EXISTS",
			`A session snapshot named "${name}" already exists. Use --force to replace it.`,
		);
	}

	// Open the source file with the snapshot directory as its destination
	// session directory so the generated branched file is written there.
	const source = SessionManager.open(input.sourceSessionFile, snapshotDir);
	const generated = source.createBranchedSession(input.leafId);
	if (!generated || !existsSync(generated)) {
		throw new SnapshotError(
			"SNAPSHOT_CREATE_FAILED",
			"The active session path could not be extracted (it may contain no assistant messages yet).",
		);
	}

	try {
		moveIntoPlace(generated, destination);
		applyFileMode(destination);
	} catch (error) {
		throw new SnapshotError(
			"SNAPSHOT_CREATE_FAILED",
			"Failed to write the session snapshot file.",
			{ cause: error },
		);
	} finally {
		if (generated !== destination && existsSync(generated)) {
			try {
				unlinkSync(generated);
			} catch {
				// best-effort cleanup of the generated timestamped file
			}
		}
	}

	return { name, file: destination };
}

export function listSnapshots(snapshotDir: string): SnapshotEntry[] {
	const directory = resolveSnapshotDir(snapshotDir);
	if (!existsSync(directory)) return [];

	const snapshots: SnapshotEntry[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".jsonl")) continue;
		let name: string;
		try {
			name = nameFromSnapshotFilename(entry.name);
		} catch {
			continue;
		}
		const file = join(directory, entry.name);
		const stats = statSync(file);
		snapshots.push({
			name,
			file,
			bytes: stats.size,
			modifiedMs: stats.mtimeMs,
		});
	}

	return snapshots.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSnapshot(snapshotDir: string, name: string): void {
	const directory = resolveSnapshotDir(snapshotDir);
	const file = resolveSnapshotFile(directory, name);
	if (!existsSync(file) || !lstatSync(file).isFile()) {
		throw new SnapshotError(
			"SNAPSHOT_NOT_FOUND",
			`No session snapshot named "${normalizeSnapshotName(name)}" was found.`,
		);
	}
	try {
		unlinkSync(file);
	} catch (error) {
		throw new SnapshotError(
			"SNAPSHOT_DELETE_FAILED",
			"Failed to delete the session snapshot file.",
			{ cause: error },
		);
	}
}

export function forkSnapshot(input: ForkSnapshotInput): ForkSnapshotResult {
	const snapshotDir = resolveSnapshotDir(input.snapshotDir);
	const snapshotFile = resolveSnapshotFile(snapshotDir, input.name);
	if (!existsSync(snapshotFile) || !lstatSync(snapshotFile).isFile()) {
		throw new SnapshotError(
			"SNAPSHOT_NOT_FOUND",
			`No session snapshot named "${normalizeSnapshotName(input.name)}" was found.`,
		);
	}

	let manager: SessionManager;
	try {
		manager = SessionManager.forkFrom(
			snapshotFile,
			input.targetCwd,
			input.targetSessionDir,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		const invalid =
			message.includes("source session file is empty or invalid") ||
			message.includes("source session has no header");
		throw new SnapshotError(
			invalid ? "SNAPSHOT_INVALID" : "SNAPSHOT_LOAD_FAILED",
			invalid
				? "The session snapshot is empty or invalid."
				: "Failed to fork a new session from the session snapshot.",
			{ cause: error },
		);
	}

	const destinationFile = manager.getSessionFile();
	if (!destinationFile || !existsSync(destinationFile)) {
		throw new SnapshotError(
			"SNAPSHOT_LOAD_FAILED",
			"The restored session file was not created.",
		);
	}

	return { destinationFile, snapshotFile };
}

export function resolveSnapshotDir(snapshotDir: string): string {
	return resolve(snapshotDir);
}