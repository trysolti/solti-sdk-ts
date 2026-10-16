/**
 * Shared resource types — deep typing: nested interfaces plus string-union
 * types for every finite value set (api spec §3, scheduler spec lifecycles).
 */

/**
 * Well-known workload statuses reported by the Task Manager / scheduler
 * (scheduler spec — `queued` → `booting` → `running` → terminal).
 */
export type WorkloadStatus =
  | "queued"
  | "booting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Statuses from which no further transitions occur. */
export type TerminalStatus = "succeeded" | "failed" | "cancelled";

/**
 * Infrastructure lifecycle (`vm_status`) — strictly monotonic (scheduler
 * spec): `nonassigned` → `provisioning` → `provisioned` → `terminating` →
 * `terminated`; `error` is reachable only from pre-`terminating` states.
 */
export type VmStatus =
  | "nonassigned"
  | "provisioning"
  | "provisioned"
  | "terminating"
  | "terminated"
  | "error";

/** Cloud providers accepted by job routing and connections (api spec §3.2). */
export type CloudProvider = "aws" | "gcp" | "azure";

/** Connection integration types (cli `solti connection create --type`). */
export type ConnectionType = "aws" | "gcp" | "azure" | "r2" | "github";

/** Key roles (api `keys/models.py`: `Role = Literal["admin", "developer", "viewer"]`). */
export type KeyRole = "admin" | "developer" | "viewer";

/** Macro-regions accepted as `region` routing constraints (api spec §3.2). */
export type MacroRegion = "americas" | "europe" | "apac" | "africa" | "middle-east";

/** Statuses from which no further transitions occur (typed constant). */
export const TERMINAL_STATUSES: readonly TerminalStatus[] = ["succeeded", "failed", "cancelled"];

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

/** Narrows an unknown raw value to a string-union type (wire values are exact). */
export function rawUnion<T extends string>(raw: RawRecord, key: string): T | undefined {
  const value = raw[key];
  return typeof value === "string" ? (value as T) : undefined;
}
