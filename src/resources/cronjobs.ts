/**
 * Cronjobs resource — periodic task definitions with UTC crontab schedules
 * and a strict `jobDefinition` template (api spec §3.3).
 *
 * All methods accept either the cronjob's unique UUID (`id`) or its unique
 * `name`. The create payload must not contain a fixed `name` inside
 * `jobDefinition` — each trigger spawns `<cronjob-name>-<UTC timestamp>`.
 */

import type { SoltiClient } from "../client.js";
import { rawBoolean, rawString, rawUnion, type RawRecord } from "./shared.js";
import type { JobDefinition } from "./jobs.js";

export interface Cronjob {
  id: string;
  name: string;
  /** UTC crontab expression. */
  cronSpec: string;
  isActive: boolean;
  lastTriggeredAt?: string;
  /** Job template spawned on each trigger (a job definition without `name`). */
  jobDefinition?: JobDefinition;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CreateCronjobRequest {
  name: string;
  /** UTC crontab expression (e.g. `"0 2 * * *"`). */
  cronSpec: string;
  /** Default true. */
  isActive?: boolean;
  /** Strict job template (a {@link JobDefinition}) — must not contain `name`. */
  jobDefinition: JobDefinition;
}

export interface PatchCronjobRequest {
  cronSpec?: string;
  isActive?: boolean;
  jobDefinition?: JobDefinition;
}

function mapCronjob(raw: RawRecord): Cronjob {
  const {
    cron_spec: cronSpec,
    is_active: isActive,
    last_triggered_at: lastTriggeredAt,
    created_at: createdAt,
    ...rest
  } = raw;
  return {
    ...rest,
    id: rawString(raw, "id") ?? "",
    name: rawString(raw, "name") ?? "",
    cronSpec: typeof cronSpec === "string" ? cronSpec : "",
    isActive: isActive === true,
    lastTriggeredAt: lastTriggeredAt as string | undefined,
    jobDefinition: raw.job_definition as JobDefinition | undefined,
    createdAt: createdAt as string | undefined,
  };
}

export class CronjobsResource {
  constructor(private readonly client: SoltiClient) {}

  async create(request: CreateCronjobRequest): Promise<Cronjob> {
    const body = {
      name: request.name,
      cron_spec: request.cronSpec,
      is_active: request.isActive ?? true,
      job_definition: request.jobDefinition,
    };
    const raw = (await this.client.request("cronjobs", { method: "POST", body })) as RawRecord;
    return mapCronjob(raw);
  }

  /** Accepts either the cronjob's unique UUID or its unique name. */
  async get(idOrName: string): Promise<Cronjob> {
    const raw = (await this.client.request(`cronjobs/${encodeURIComponent(idOrName)}`)) as RawRecord;
    return mapCronjob(raw);
  }

  async list(): Promise<Cronjob[]> {
    const data = (await this.client.request("cronjobs")) as { cronjobs?: RawRecord[] } | RawRecord[];
    const items = Array.isArray(data) ? data : (data.cronjobs ?? []);
    return items.map(mapCronjob);
  }

  /** Updates schedule / active flag / job template without recreating the resource. */
  async patch(idOrName: string, request: PatchCronjobRequest): Promise<Cronjob> {
    const body: Record<string, unknown> = {};
    if (request.cronSpec !== undefined) body.cron_spec = request.cronSpec;
    if (request.isActive !== undefined) body.is_active = request.isActive;
    if (request.jobDefinition !== undefined) body.job_definition = request.jobDefinition;
    const raw = (await this.client.request(`cronjobs/${encodeURIComponent(idOrName)}`, {
      method: "PATCH",
      body,
    })) as RawRecord;
    return mapCronjob(raw);
  }

  /** Alias for {@link CronjobsResource.patch} (sdk.md §2 `.update`). */
  async update(idOrName: string, request: PatchCronjobRequest): Promise<Cronjob> {
    return this.patch(idOrName, request);
  }

  /** Accepts either the cronjob's unique UUID or its unique name. */
  async delete(idOrName: string): Promise<void> {
    await this.client.request(`cronjobs/${encodeURIComponent(idOrName)}`, { method: "DELETE" });
  }
}
