/**
 * Solti SDK client — host strategy, auth, and error mapping.
 *
 * Host strategy (Change 015 WS2): per-project wildcard hosts
 * (`<project-id>.api.solti.run`) are NOT deployed. The SDK always targets the
 * global host and selects the project via the `X-Solti-Project-Id` header —
 * exactly the deployed mechanism of ../solti-cli/src/api/client.ts.
 *
 * Auth: `X-Solti-API-Key` header, from the explicit `apiKey` option or the
 * `SOLTI_API_KEY` environment variable.
 */

import { AuthenticationError, PermissionDeniedError, RateLimitError, SoltiApiError, ValidationError } from "./errors.js";
import { ConnectionsResource } from "./resources/connections.js";
import { CronjobsResource } from "./resources/cronjobs.js";
import { JobsResource } from "./resources/jobs.js";
import { KeysResource } from "./resources/keys.js";

/** Global API host — same default as the CLI (`SOLTI_API_URL_GLOBAL` override supported). */
export const GLOBAL_API_URL = process.env.SOLTI_API_URL_GLOBAL ?? "https://api.solti.run/1";

export interface SoltiClientOptions {
  /** Zitadel-managed PAT. Falls back to the `SOLTI_API_KEY` environment variable. */
  apiKey?: string;
  /** API base URL including the `/1` version segment. Defaults to the global host. */
  apiUrl?: string;
  /** Project selection — sent as the `X-Solti-Project-Id` header (no per-project hostnames). */
  projectId?: string;
}

export class SoltiClient {
  readonly apiKey: string;
  readonly apiUrl: string;
  readonly projectId?: string;

  /** Jobs lifecycle: create / get / list / cancel / waitUntilComplete. */
  readonly jobs: JobsResource;
  /** Connections CRUD. */
  readonly connections: ConnectionsResource;
  /** Cronjobs management (addressable by UUID `id` or unique `name`). */
  readonly cronjobs: CronjobsResource;
  /** API keys (admin-only endpoints). */
  readonly keys: KeysResource;

  constructor(options: SoltiClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.SOLTI_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("No API key provided. Pass `apiKey` or set the SOLTI_API_KEY environment variable.");
    }
    this.apiKey = apiKey;
    this.apiUrl = (options.apiUrl ?? GLOBAL_API_URL).replace(/\/+$/, "");
    this.projectId = options.projectId === "" ? undefined : options.projectId;

    this.jobs = new JobsResource(this);
    this.connections = new ConnectionsResource(this);
    this.cronjobs = new CronjobsResource(this);
    this.keys = new KeysResource(this);
  }

  /** Performs an API request. `path` is relative to the `/1` base (e.g. `jobs`). */
  async request(
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { "X-Solti-API-Key": this.apiKey };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.projectId !== undefined) headers["X-Solti-Project-Id"] = this.projectId;

    let url = `${this.apiUrl}/${path.replace(/^\//, "")}`;
    const query = options.query ?? {};
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const queryString = params.toString();
    if (queryString !== "") url += `?${queryString}`;

    const isIdempotentRead = method === "GET";
    let attempts = 0;
    let retryAfterMs = 0;

    // Rate-limit friendly behavior (api spec §5): auto-retry idempotent reads
    // honoring `Retry-After` (capped at 30s), generalized from
    // ../solti-cli/src/api/client.ts. Mutations surface `RateLimitError`.
    for (;;) {
      if (retryAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      }
      attempts += 1;
      const response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (response.status === 429 && isIdempotentRead && attempts <= 2) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
        retryAfterMs = Math.min(Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000, 30_000);
        continue;
      }

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text === "" ? null : JSON.parse(text);
      } catch {
        payload = text;
      }
      if (!response.ok) {
        if (response.status === 401) throw new AuthenticationError(response.status, payload);
        if (response.status === 403) throw new PermissionDeniedError(response.status, payload);
        if (response.status === 422) throw new ValidationError(response.status, payload);
        if (response.status === 429) throw new RateLimitError(response.status, payload, response.headers);
        throw new SoltiApiError(response.status, payload);
      }
      return payload;
    }
  }
}
