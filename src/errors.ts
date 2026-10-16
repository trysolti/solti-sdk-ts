/**
 * Error mapping per constitution/tools/sdk.md §5.
 *
 * Every HTTP error surfaces as a `SoltiApiError` subclass (or `SoltiApiError`
 * itself for statuses without a dedicated type). `RateLimitError` carries the
 * server-provided `retry_after` (seconds) and the `X-RateLimit-*` headers.
 */

export class SoltiApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Parsed response body (JSON object when parseable, raw text otherwise). */
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message?: string) {
    super(message ?? `Solti API error (HTTP ${status})`);
    this.name = "SoltiApiError";
    this.status = status;
    this.payload = payload;
  }
}

/** 401 — the API key (Zitadel PAT) is invalid or has expired. */
export class AuthenticationError extends SoltiApiError {
  constructor(status: number, payload: unknown) {
    super(status, payload, "Authentication failed: the API key is invalid or has expired.");
    this.name = "AuthenticationError";
  }
}

/** 403 — the key's role is not allowed to perform this operation (e.g. `viewer` on a write). */
export class PermissionDeniedError extends SoltiApiError {
  constructor(status: number, payload: unknown) {
    super(status, payload, "Permission denied: this API key's role does not permit this operation.");
    this.name = "PermissionDeniedError";
  }
}

/** 422 — the payload contains invalid configuration (e.g. invalid cron expression, malformed volume). */
export class ValidationError extends SoltiApiError {
  constructor(status: number, payload: unknown) {
    super(status, payload, "Validation failed: the request payload contains invalid configuration.");
    this.name = "ValidationError";
  }
}

/** 429 — rate limit exceeded. Idempotent reads are auto-retried by the client; mutations surface this error. */
export class RateLimitError extends SoltiApiError {
  /** Server-provided `Retry-After` in seconds (defaults to 5 when absent). */
  readonly retryAfter: number;
  /** `X-RateLimit-Limit` header value, when present. */
  readonly limit?: number;
  /** `X-RateLimit-Remaining` header value, when present. */
  readonly remaining?: number;
  /** `X-RateLimit-Reset` header value (unix epoch seconds), when present. */
  readonly reset?: number;

  constructor(status: number, payload: unknown, headers: Headers) {
    super(status, payload, "Rate limit exceeded.");
    this.name = "RateLimitError";

    const retryAfter = Number(headers.get("Retry-After") ?? "5");
    this.retryAfter = Number.isFinite(retryAfter) ? retryAfter : 5;

    const limit = Number(headers.get("X-RateLimit-Limit"));
    if (Number.isFinite(limit)) this.limit = limit;
    const remaining = Number(headers.get("X-RateLimit-Remaining"));
    if (Number.isFinite(remaining)) this.remaining = remaining;
    const reset = Number(headers.get("X-RateLimit-Reset"));
    if (Number.isFinite(reset)) this.reset = reset;
  }
}

/**
 * Raised by `waitUntilComplete` when the job reaches a terminal `failed`
 * state (non-zero container exit, execution error, or OOM).
 */
export class WorkloadFailedError extends Error {
  readonly status: number;
  readonly payload: unknown;
  /** Container exit code, when the Task Manager reported one. */
  readonly exitCode?: number;
  /** Logged error summary, when present. */
  readonly errorSummary?: string;
  /** True when the container was killed by the OOM killer. */
  readonly oom?: boolean;
  /** Final job state at failure time. */
  readonly job?: JobSnapshot;

  constructor(options: {
    exitCode?: number;
    errorSummary?: string;
    oom?: boolean;
    job?: JobSnapshot;
    status?: number;
    payload?: unknown;
  }) {
    const code = options.exitCode !== undefined ? ` (exit code ${options.exitCode})` : "";
    const oomSuffix = options.oom === true ? " — container was OOM-killed" : "";
    super(`Workload failed${code}${oomSuffix}${options.errorSummary !== undefined ? `: ${options.errorSummary}` : ""}`);
    this.name = "WorkloadFailedError";
    this.exitCode = options.exitCode;
    this.errorSummary = options.errorSummary;
    this.oom = options.oom;
    this.job = options.job;
    this.status = options.status ?? 0;
    this.payload = options.payload ?? null;
  }
}

/** Minimal snapshot of the failed job attached to {@link WorkloadFailedError}. */
export interface JobSnapshot {
  id: string;
  name: string;
  status: string;
  [key: string]: unknown;
}

/** Raised by `waitUntilComplete` when the client-side wait timeout is exceeded. */
export class TimeoutError extends Error {
  constructor(message = "Workload did not complete before the client-side timeout.") {
    super(message);
    this.name = "TimeoutError";
  }
}
