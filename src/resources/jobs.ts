/**
 * Jobs resource — submit, inspect, list, cancel workloads, and block on
 * completion with `waitUntilComplete` (sdk.md §4.1).
 *
 * Request payloads use camelCase wire keys (`namePrefix`, `maxRetries`,
 * `mountPath` — api spec §3.0); responses are snake_case and are mapped to
 * camelCase SDK types (`vmStatus`, `estimatedCost`, `exitCode`).
 */

import type { SoltiClient } from "../client.js";
import { TimeoutError, WorkloadFailedError } from "../errors.js";
import {
  TERMINAL_STATUSES,
  rawBoolean,
  rawNumber,
  rawString,
  rawUnion,
  type CloudProvider,
  type RawRecord,
  type TerminalStatus,
  type VmStatus,
  type WorkloadStatus,
} from "./shared.js";

/** Default client-side polling interval (sdk.md §3.1: 10s). */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** A storage volume mount, keyed by volume name in the `volumes` map. */
export interface VolumeMount {
  /** Required: source bucket. */
  bucket: string;
  /** Required: in-container mount path. */
  mountPath: string;
  /** Optional: connection name (defaults to the first connection with bucket access). */
  connection?: string;
  /** Optional: bucket prefix (defaults to the bucket root). */
  prefix?: string;
}

/**
 * Nested GPU request (api spec §3.2 `resources.gpu` long form). Hard
 * constraints are never silently relaxed: unsatisfiable requests fail at
 * scheduling with an explicit configuration error.
 */
export interface GpuRequest {
  /** Minimum aggregate GPU VRAM (e.g. `"24Gi"`); required unless `model` is given. */
  vram?: string;
  /** Hard constraint on GPU model (e.g. `"A100"`); matched case-insensitively. */
  model?: string;
  /** Hard constraint on the minimum number of physical GPUs (requires `model`). */
  count?: number;
}

/** Compute resources; `gpu` is the VRAM shorthand or a nested {@link GpuRequest}. */
export interface JobResources {
  cpu?: number;
  memory?: string;
  gpu?: string | GpuRequest;
}

export interface CreateJobRequest {
  /** Optional unique job name (unique per project). */
  name?: string;
  /** Optional prefix — auto-generates a unique `<prefix>-<random_suffix>` name. */
  namePrefix?: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  /** Map keyed by volume name. */
  volumes?: Record<string, VolumeMount>;
  resources?: JobResources;
  /** Optional provider constraints (e.g. `["aws", "gcp"]`). */
  cloud?: CloudProvider | CloudProvider[];
  /** Optional specific region(s) or macro-region. */
  region?: string | string[];
  /** Container retries inside the VM. */
  maxRetries?: number;
  labels?: Record<string, string>;
  tags?: string[];
}

/** Cronjob job template — a standard job definition without `name` (api spec
 * §3.3: each trigger spawns `<cronjob-name>-<UTC timestamp>`). */
export type JobDefinition = Omit<CreateJobRequest, "name" | "namePrefix">;

export interface JobListFilters {
  status?: WorkloadStatus;
  /** Tag filter (single value). */
  tag?: string;
  /** Label filter in the `key:value` form. */
  label?: string;
  /** Page size (default 50, max 200). */
  limit?: number;
  offset?: number;
}

/** Mapped job state (camelCase view of the snake_case API response). */
export interface JobData {
  id: string;
  name: string;
  status: WorkloadStatus;
  image?: string;
  vmStatus?: VmStatus;
  estimatedCost?: number;
  actualCost?: number;
  retryCount?: number;
  maxRetries?: number;
  errorSummary?: string;
  exitCode?: number;
  /** OOM flag reported by the Task Manager. */
  oom?: boolean;
  /** OOM-killed flag (alternate wire key for the same signal). */
  oomKilled?: boolean;
  labels?: Record<string, string>;
  tags?: string[];
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WaitUntilCompleteOptions {
  /** Client-side wait timeout; a `TimeoutError` is thrown when exceeded. */
  timeoutMs?: number;
  /** Polling interval. Default 10s. */
  pollIntervalMs?: number;
  /** Invoked whenever the reported status changes. */
  onProgress?: (status: WorkloadStatus) => void;
  /** Best-effort `jobs.cancel` when the timeout fires. Default false. */
  cancelOnTimeout?: boolean;
}

export function mapJob(raw: RawRecord): JobData {
  return {
    id: rawString(raw, "id") ?? rawString(raw, "job_id") ?? "",
    name: rawString(raw, "name") ?? "",
    status: rawUnion<WorkloadStatus>(raw, "status") ?? ("" as WorkloadStatus),
    image: rawString(raw, "image"),
    vmStatus: rawUnion<VmStatus>(raw, "vm_status"),
    estimatedCost: rawNumber(raw, "estimated_cost"),
    actualCost: rawNumber(raw, "actual_cost"),
    retryCount: rawNumber(raw, "retry_count"),
    maxRetries: rawNumber(raw, "max_retries"),
    errorSummary: rawString(raw, "error_summary"),
    exitCode: rawNumber(raw, "exit_code"),
    oom: rawBoolean(raw, "oom"),
    oomKilled: rawBoolean(raw, "oom_killed"),
    labels: raw.labels as Record<string, string> | undefined,
    tags: raw.tags as string[] | undefined,
    createdAt: rawString(raw, "created_at"),
    startedAt: rawString(raw, "started_at"),
    finishedAt: rawString(raw, "finished_at"),
  };
}

/** A submitted/fetched job; carries `waitUntilComplete` for lifecycle control. */
export class Job implements JobData {
  readonly id: string;
  readonly name: string;
  readonly status: WorkloadStatus;
  readonly image?: string;
  readonly vmStatus?: VmStatus;
  readonly estimatedCost?: number;
  readonly actualCost?: number;
  readonly retryCount?: number;
  readonly maxRetries?: number;
  readonly errorSummary?: string;
  readonly exitCode?: number;
  readonly oom?: boolean;
  readonly oomKilled?: boolean;
  readonly labels?: Record<string, string>;
  readonly tags?: string[];
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;

  constructor(
    data: JobData,
    private readonly client: SoltiClient,
  ) {
    this.id = data.id;
    this.name = data.name;
    this.status = data.status;
    this.image = data.image;
    this.vmStatus = data.vmStatus;
    this.estimatedCost = data.estimatedCost;
    this.actualCost = data.actualCost;
    this.retryCount = data.retryCount;
    this.maxRetries = data.maxRetries;
    this.errorSummary = data.errorSummary;
    this.exitCode = data.exitCode;
    this.oom = data.oom;
    this.oomKilled = data.oomKilled;
    this.labels = data.labels;
    this.tags = data.tags;
    this.createdAt = data.createdAt;
    this.startedAt = data.startedAt;
    this.finishedAt = data.finishedAt;
  }

  /**
   * Polls until the job reaches a terminal state (default interval 10s).
   * Throws `WorkloadFailedError` on a terminal `failed` state (non-zero exit,
   * execution error, or OOM) and `TimeoutError` when `timeoutMs` is exceeded
   * (optionally cancelling the job first via `cancelOnTimeout`).
   */
  async waitUntilComplete(options: WaitUntilCompleteOptions = {}): Promise<Job> {
    return waitUntilComplete(this.client, this.id, options);
  }
}

/** Shared polling loop used by `Job.waitUntilComplete` and `jobs.waitUntilComplete`. */
export async function waitUntilComplete(
  client: SoltiClient,
  idOrName: string,
  options: WaitUntilCompleteOptions = {},
): Promise<Job> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
  let lastStatus: WorkloadStatus | undefined;

  for (;;) {
    const job = await client.jobs.get(idOrName);
    if (job.status !== lastStatus) {
      options.onProgress?.(job.status);
      lastStatus = job.status;
    }

    if (TERMINAL_STATUSES.includes(job.status as TerminalStatus)) {
      if (job.status === "failed") {
        throw new WorkloadFailedError({
          exitCode: job.exitCode,
          errorSummary: job.errorSummary,
          oom: job.oom === true || job.oomKilled === true ? true : undefined,
          job: {
            id: job.id,
            name: job.name,
            status: job.status,
            exitCode: job.exitCode,
            errorSummary: job.errorSummary,
          },
        });
      }
      return job;
    }

    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if (options.cancelOnTimeout === true) {
          // Best-effort: the TimeoutError is the primary outcome; a failing
          // cancel (e.g. job completed between polls) must not mask it.
          try {
            await client.jobs.cancel(idOrName);
          } catch {
            // ignored deliberately
          }
        }
        throw new TimeoutError(
          `Job ${idOrName} did not complete within the client-side timeout (${options.timeoutMs}ms).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

export class JobsResource {
  constructor(private readonly client: SoltiClient) {}

  async create(request: CreateJobRequest): Promise<Job> {
    const raw = (await this.client.request("jobs", { method: "POST", body: request })) as RawRecord;
    return new Job(mapJob(raw), this.client);
  }

  /** Accepts either the job's unique UUID or its unique name. */
  async get(idOrName: string): Promise<Job> {
    const raw = (await this.client.request(`jobs/${encodeURIComponent(idOrName)}`)) as RawRecord;
    return new Job(mapJob(raw), this.client);
  }

  async list(filters: JobListFilters = {}): Promise<Job[]> {
    const data = (await this.client.request("jobs", {
      query: {
        status: filters.status,
        tag: filters.tag,
        label: filters.label,
        limit: filters.limit,
        offset: filters.offset,
      },
    })) as { jobs?: RawRecord[] } | RawRecord[];
    const items = Array.isArray(data) ? data : (data.jobs ?? []);
    return items.map((raw) => new Job(mapJob(raw), this.client));
  }

  /** Cancels a running, booting, or queued job (by UUID or name). */
  async cancel(idOrName: string): Promise<void> {
    await this.client.request(`jobs/${encodeURIComponent(idOrName)}/cancel`, { method: "POST" });
  }

  /** Polls `jobs.get` until the job reaches a terminal state. See {@link Job.waitUntilComplete}. */
  async waitUntilComplete(idOrName: string, options: WaitUntilCompleteOptions = {}): Promise<Job> {
    return waitUntilComplete(this.client, idOrName, options);
  }
}
