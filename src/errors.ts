export type SnapshotErrorCode =
  | "INVALID_NAME"
  | "SESSION_NOT_PERSISTED"
  | "SESSION_EMPTY"
  | "SNAPSHOT_EXISTS"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_INVALID"
  | "SNAPSHOT_CREATE_FAILED"
  | "SNAPSHOT_LOAD_FAILED"
  | "SNAPSHOT_DELETE_FAILED"
  | "UI_UNAVAILABLE"
  | "INVALID_ARGUMENT";

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export function formatSnapshotError(error: unknown): string {
  if (error instanceof SnapshotError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
