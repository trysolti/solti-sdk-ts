# @solti/sdk

Solti Platform TypeScript SDK — submit and orchestrate workloads, manage
connections and cronjobs from Node.js backends, serverless endpoints, and
orchestrators, without managing infrastructure.

## Install

```bash
npm i @solti/sdk
# or
pnpm add @solti/sdk
```

Requires Node.js >= 20 (native `fetch`).

## Quick start

```typescript
import { SoltiClient } from "@solti/sdk";

// apiKey falls back to the SOLTI_API_KEY environment variable.
// The project is selected via the X-Solti-Project-Id header — the SDK always
// targets the global API host (per-project wildcard hosts are not deployed).
const client = new SoltiClient({
  apiKey: process.env.SOLTI_API_KEY,
  projectId: "<project-id>",
});

const job = await client.jobs.create({
  namePrefix: "postgres-cleanup-",
  image: "postgres:18-alpine",
  command: ["psql"],
  args: ["-c", "VACUUM ANALYZE;"],
  resources: { cpu: 2, memory: "4Gi" },
  labels: { environment: "production" },
  tags: ["maintenance"],
});

console.log(`Job submitted: ${job.id} (${job.status})`);

const finalJob = await job.waitUntilComplete({
  timeoutMs: 600_000,
  onProgress: (status) => console.log(`Status: ${status}`),
});
```

## Error handling

```typescript
import {
  WorkloadFailedError,
  TimeoutError,
  RateLimitError,
  AuthenticationError,
  PermissionDeniedError,
  ValidationError,
} from "@solti/sdk";

try {
  await job.waitUntilComplete({ timeoutMs: 600_000 });
} catch (e) {
  if (e instanceof WorkloadFailedError) {
    console.error(`Workload failed: exit ${e.exitCode}\n${e.errorSummary}`);
  } else if (e instanceof TimeoutError) {
    await client.jobs.cancel(job.id);
  }
}
```

Error mapping per the client tools spec:

| Error | Condition |
| --- | --- |
| `AuthenticationError` | HTTP 401 — invalid or expired API key (Zitadel PAT) |
| `PermissionDeniedError` | HTTP 403 — key role too weak (e.g. `viewer` on a write) |
| `ValidationError` | HTTP 422 — invalid payload configuration |
| `RateLimitError` | HTTP 429 — exposes `retryAfter` and the `X-RateLimit-*` headers |
| `WorkloadFailedError` | Terminal `failed` state during `waitUntilComplete` (`exitCode`, `errorSummary`, OOM flag) |
| `TimeoutError` | Client-side wait timeout exceeded |

Idempotent reads (GET) are auto-retried on 429 honoring `Retry-After`
(capped at 30s, at most 2 retries); mutations surface `RateLimitError`.

## Resources

- `client.jobs` — `create`, `get`, `list`, `cancel`, `waitUntilComplete`
- `client.connections` — `create`, `get`, `list`, `delete`
- `client.cronjobs` — `create`, `get`, `list`, `patch`/`update`, `delete` (by UUID `id` or unique `name`)
- `client.keys` — `create`, `list`, `delete` (admin only)

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `SOLTI_API_KEY` env | Zitadel-managed PAT |
| `apiUrl` | `https://api.solti.run/1` (`SOLTI_API_URL_GLOBAL` env overrides) | API base URL (use `https://preview.api.solti.run/1` for preview) |
| `projectId` | — | Sent as `X-Solti-Project-Id` |
