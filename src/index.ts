/**
 * @solti/sdk — Solti Platform TypeScript SDK.
 *
 * Usage:
 * ```ts
 * import { SoltiClient } from "@solti/sdk";
 *
 * const client = new SoltiClient({ apiKey: process.env.SOLTI_API_KEY, projectId: "<project-id>" });
 * const job = await client.jobs.create({ image: "alpine:latest", command: ["echo", "hi"] });
 * const finalJob = await job.waitUntilComplete({ timeoutMs: 600_000 });
 * ```
 */

export { SoltiClient, GLOBAL_API_URL, type SoltiClientOptions } from "./client.js";

export {
  SoltiApiError,
  AuthenticationError,
  PermissionDeniedError,
  ValidationError,
  RateLimitError,
  WorkloadFailedError,
  TimeoutError,
  type JobSnapshot,
} from "./errors.js";

export type {
  VolumeMount,
  JobResources,
  GpuRequest,
  JobDefinition,
  CreateJobRequest,
  JobListFilters,
  JobData,
  WaitUntilCompleteOptions,
} from "./resources/jobs.js";
export { Job, JobsResource, DEFAULT_POLL_INTERVAL_MS } from "./resources/jobs.js";

export type {
  Connection,
  ConnectionCreateRequest,
  ConnectionCredentials,
  AwsCredentials,
  GcpCredentials,
  AzureCredentials,
  R2Credentials,
  GithubCredentials,
} from "./resources/connections.js";
export { ConnectionsResource } from "./resources/connections.js";

export type { Cronjob, CreateCronjobRequest, PatchCronjobRequest } from "./resources/cronjobs.js";
export { CronjobsResource } from "./resources/cronjobs.js";

export type { Key, CreateKeyRequest, CreateKeyResponse } from "./resources/keys.js";
export { KeysResource } from "./resources/keys.js";

export { TERMINAL_STATUSES } from "./resources/shared.js";
export type {
  WorkloadStatus,
  TerminalStatus,
  VmStatus,
  CloudProvider,
  ConnectionType,
  KeyRole,
  MacroRegion,
} from "./resources/shared.js";
