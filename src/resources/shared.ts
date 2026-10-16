/**
 * Shared resource types.
 */

/** Well-known workload statuses reported by the Task Manager / scheduler. */
export type WorkloadStatus =
  | "queued"
  | "booting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Statuses from which no further transitions occur. */
export const TERMINAL_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled"];

/** Raw API responses are snake_case; helpers below map to camelCase SDK types. */
export type RawRecord = Record<string, unknown>;

export function rawString(raw: RawRecord, key: string): string | undefined {
  const value = raw[key];
  return typeof value === "string" ? value : undefined;
}

export function rawNumber(raw: RawRecord, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" ? value : undefined;
}

export function rawBoolean(raw: RawRecord, key: string): boolean | undefined {
  const value = raw[key];
  return typeof value === "boolean" ? value : undefined;
}
