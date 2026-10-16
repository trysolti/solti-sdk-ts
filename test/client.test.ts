import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  SoltiApiError,
  SoltiClient,
  TimeoutError,
  ValidationError,
  WorkloadFailedError,
} from "../src/index.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

interface TestServer {
  server: Server;
  url: string;
  requests: CapturedRequest[];
  /** Override the handler mid-test. */
  setHandler: (handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void) => void;
}

function startServer(handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  let current = handler;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = text === "" ? null : JSON.parse(text);
      } catch {
        body = text;
      }
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body,
      });
      current(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        url: `http://127.0.0.1:${port}/1`,
        requests,
        setHandler: (h) => {
          current = h;
        },
      });
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

let ts: TestServer;
let client: SoltiClient;

beforeEach(async () => {
  ts = await startServer(() => json({} as ServerResponse, 200, {}));
  client = new SoltiClient({ apiKey: "test-key", apiUrl: ts.url, projectId: "proj-1" });
});

afterEach(async () => {
  await new Promise<void>((resolve) => ts.server.close(() => resolve()));
});

describe("SoltiClient construction", () => {
  it("throws when no API key is provided", () => {
    const prev = process.env.SOLTI_API_KEY;
    delete process.env.SOLTI_API_KEY;
    try {
      expect(() => new SoltiClient({ apiUrl: ts.url })).toThrow(/SOLTI_API_KEY/);
    } finally {
      if (prev !== undefined) process.env.SOLTI_API_KEY = prev;
    }
  });

  it("falls back to the SOLTI_API_KEY environment variable", async () => {
    const prev = process.env.SOLTI_API_KEY;
    process.env.SOLTI_API_KEY = "env-key";
    try {
      const envClient = new SoltiClient({ apiUrl: ts.url });
      ts.setHandler((_req, res) => json(res, 200, { jobs: [] }));
      await envClient.jobs.list();
      expect(ts.requests[0].headers["x-solti-api-key"]).toBe("env-key");
    } finally {
      if (prev === undefined) delete process.env.SOLTI_API_KEY;
      else process.env.SOLTI_API_KEY = prev;
    }
  });

  it("defaults to the global host when no apiUrl is given", () => {
    const prev = process.env.SOLTI_API_URL_GLOBAL;
    delete process.env.SOLTI_API_URL_GLOBAL;
    try {
      const c = new SoltiClient({ apiKey: "k" });
      expect(c.apiUrl).toBe("https://api.solti.run/1");
    } finally {
      if (prev !== undefined) process.env.SOLTI_API_URL_GLOBAL = prev;
    }
  });

  it("does not resolve per-project wildcard hosts", () => {
    const c = new SoltiClient({ apiKey: "k", projectId: "proj-38749" });
    expect(c.apiUrl).toBe("https://api.solti.run/1");
  });
});

describe("auth and project headers", () => {
  it("sends X-Solti-API-Key and X-Solti-Project-Id", async () => {
    ts.setHandler((_req, res) => json(res, 200, { jobs: [] }));
    await client.jobs.list();
    const req = ts.requests[0];
    expect(req.headers["x-solti-api-key"]).toBe("test-key");
    expect(req.headers["x-solti-project-id"]).toBe("proj-1");
    expect(req.url).toBe("/1/jobs");
  });

  it("omits X-Solti-Project-Id when no project is set", async () => {
    const c = new SoltiClient({ apiKey: "test-key", apiUrl: ts.url });
    ts.setHandler((_req, res) => json(res, 200, { jobs: [] }));
    await c.jobs.list();
    expect(ts.requests[0].headers["x-solti-project-id"]).toBeUndefined();
  });
});

describe("error mapping (sdk.md §5)", () => {
  const cases: Array<{ status: number; expected: new (...args: never[]) => Error; name: string }> = [
    { status: 401, expected: AuthenticationError, name: "AuthenticationError" },
    { status: 403, expected: PermissionDeniedError, name: "PermissionDeniedError" },
    { status: 422, expected: ValidationError, name: "ValidationError" },
  ];
  for (const { status, expected, name } of cases) {
    it(`maps HTTP ${status} to ${name}`, async () => {
      ts.setHandler((_req, res) => json(res, status, { detail: "boom" }));
      await expect(client.jobs.list()).rejects.toMatchObject({
        name,
        status,
        payload: { detail: "boom" },
      });
      await expect(client.jobs.list()).rejects.toBeInstanceOf(expected);
    });
  }

  it("maps other statuses to the generic SoltiApiError", async () => {
    ts.setHandler((_req, res) => json(res, 404, { detail: "missing" }));
    await expect(client.jobs.get("nope")).rejects.toBeInstanceOf(SoltiApiError);
    await expect(client.jobs.get("nope")).rejects.toMatchObject({ status: 404 });
  });

  it("maps HTTP 429 to RateLimitError with retryAfter and X-RateLimit-* headers", async () => {
    ts.setHandler((_req, res) =>
      json(res, 429, { detail: "slow down" }, {
        "Retry-After": "17",
        "X-RateLimit-Limit": "120",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1728123456",
      }),
    );
    const err = await client.jobs.create({ image: "alpine:latest" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    const rle = err as RateLimitError;
    expect(rle.retryAfter).toBe(17);
    expect(rle.limit).toBe(120);
    expect(rle.remaining).toBe(0);
    expect(rle.reset).toBe(1728123456);
  });
});

describe("rate-limit auto-retry", () => {
  it("retries idempotent GETs honoring Retry-After (at most 2 retries)", async () => {
    let calls = 0;
    ts.setHandler((_req, res) => {
      calls += 1;
      if (calls <= 2) json(res, 429, {}, { "Retry-After": "0" });
      else json(res, 200, { jobs: [] });
    });
    await client.jobs.list();
    expect(calls).toBe(3);
  });

  it("does not retry mutations", async () => {
    let calls = 0;
    ts.setHandler((_req, res) => {
      calls += 1;
      json(res, 429, {}, { "Retry-After": "0" });
    });
    await expect(client.jobs.create({ image: "alpine:latest" })).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(1);
  });

  it("gives up after 2 retries on persistent 429s", async () => {
    let calls = 0;
    ts.setHandler((_req, res) => {
      calls += 1;
      json(res, 429, {}, { "Retry-After": "0" });
    });
    await expect(client.jobs.list()).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(3);
  });
});

describe("jobs resource", () => {
  it("creates a job with a camelCase wire payload", async () => {
    ts.setHandler((_req, res) => json(res, 200, { id: "job-1", name: "train-a1b2", status: "queued" }));
    const job = await client.jobs.create({
      namePrefix: "train-",
      image: "pytorch/pytorch:2.2.1-cuda12.1-cudnn8-runtime",
      command: ["python3"],
      args: ["train.py"],
      env: { EPOCHS: "50" },
      volumes: { datasets: { bucket: "ml-artifacts", mountPath: "/mnt/s3", connection: "my-aws-s3", prefix: "ckpts" } },
      resources: { cpu: 8, memory: "32Gi", gpu: "24Gi" },
      cloud: ["aws", "gcp"],
      region: "us-east-1",
      maxRetries: 3,
      labels: { team: "ml" },
      tags: ["training"],
    });
    expect(job.id).toBe("job-1");
    expect(job.status).toBe("queued");
    const body = ts.requests[0].body as Record<string, unknown>;
    expect(ts.requests[0].method).toBe("POST");
    expect(ts.requests[0].url).toBe("/1/jobs");
    expect(body).toMatchObject({
      namePrefix: "train-",
      image: "pytorch/pytorch:2.2.1-cuda12.1-cudnn8-runtime",
      maxRetries: 3,
      volumes: { datasets: { bucket: "ml-artifacts", mountPath: "/mnt/s3" } },
      resources: { cpu: 8, memory: "32Gi", gpu: "24Gi" },
    });
  });

  it("maps snake_case response fields to camelCase", async () => {
    ts.setHandler((_req, res) =>
      json(res, 200, {
        id: "job-1",
        name: "train-a1b2",
        status: "running",
        vm_status: "provisioned",
        estimated_cost: 1.5,
        actual_cost: 2.5,
        retry_count: 1,
        max_retries: 3,
        error_summary: null,
        exit_code: null,
      }),
    );
    const job = await client.jobs.get("job-1");
    expect(job.vmStatus).toBe("provisioned");
    expect(job.estimatedCost).toBe(1.5);
    expect(job.actualCost).toBe(2.5);
    expect(job.retryCount).toBe(1);
    expect(job.maxRetries).toBe(3);
  });

  it("lists jobs with query filters and unwraps the jobs array", async () => {
    ts.setHandler((_req, res) =>
      json(res, 200, { jobs: [{ id: "job-1", name: "a", status: "queued" }, { id: "job-2", name: "b", status: "running" }] }),
    );
    const jobs = await client.jobs.list({ status: "queued", label: "environment:production", limit: 50, offset: 0 });
    expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(ts.requests[0].url).toBe(
      "/1/jobs?status=queued&label=environment%3Aproduction&limit=50&offset=0",
    );
  });

  it("cancels via POST /1/jobs/{id}/cancel accepting id or name", async () => {
    ts.setHandler((_req, res) => json(res, 200, {}));
    await client.jobs.cancel("my-job-name");
    expect(ts.requests[0]).toMatchObject({ method: "POST", url: "/1/jobs/my-job-name/cancel" });
  });
});

describe("waitUntilComplete", () => {
  it("polls until a terminal state and reports progress", async () => {
    const statuses = ["queued", "booting", "running", "succeeded"];
    let calls = 0;
    ts.setHandler((_req, res) => {
      json(res, 200, { id: "job-1", name: "a", status: statuses[Math.min(calls, statuses.length - 1)] });
      calls += 1;
    });
    const seen: string[] = [];
    const final = await client.jobs.waitUntilComplete("job-1", {
      pollIntervalMs: 1,
      onProgress: (s) => seen.push(s),
    });
    expect(final.status).toBe("succeeded");
    expect(seen).toEqual(["queued", "booting", "running", "succeeded"]);
  });

  it("throws WorkloadFailedError with exitCode/errorSummary/oom on failure", async () => {
    ts.setHandler((_req, res) =>
      json(res, 200, {
        id: "job-1",
        name: "a",
        status: "failed",
        exit_code: 3,
        error_summary: "segfault in trainer",
        oom: true,
      }),
    );
    const err = await client.jobs.waitUntilComplete("job-1", { pollIntervalMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkloadFailedError);
    const wfe = err as WorkloadFailedError;
    expect(wfe.exitCode).toBe(3);
    expect(wfe.errorSummary).toBe("segfault in trainer");
    expect(wfe.oom).toBe(true);
    expect(wfe.job?.id).toBe("job-1");
  });

  it("treats oom_killed as the OOM flag", async () => {
    ts.setHandler((_req, res) =>
      json(res, 200, { id: "job-1", name: "a", status: "failed", exit_code: 137, oom_killed: true }),
    );
    const err = await client.jobs.waitUntilComplete("job-1", { pollIntervalMs: 1 }).catch((e: unknown) => e);
    expect((err as WorkloadFailedError).oom).toBe(true);
  });

  it("throws TimeoutError on client-side timeout and can cancel on timeout", async () => {
    ts.setHandler((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/cancel")) {
        json(res, 200, {});
        return;
      }
      json(res, 200, { id: "job-1", name: "a", status: "running" });
    });
    await expect(
      client.jobs.waitUntilComplete("job-1", { pollIntervalMs: 2, timeoutMs: 30, cancelOnTimeout: true }),
    ).rejects.toBeInstanceOf(TimeoutError);
    const cancel = ts.requests.find((r) => r.method === "POST" && r.url === "/1/jobs/job-1/cancel");
    expect(cancel).toBeDefined();
  });

  it("is also available on the returned Job instance", async () => {
    let calls = 0;
    ts.setHandler((_req, res) => {
      json(res, 200, { id: "job-1", name: "a", status: calls === 0 ? "queued" : "succeeded" });
      calls += 1;
    });
    const job = await client.jobs.get("job-1");
    const final = await job.waitUntilComplete({ pollIntervalMs: 1 });
    expect(final.status).toBe("succeeded");
  });
});

describe("connections resource", () => {
  it("creates a connection, flattening credentials into the wire payload", async () => {
    ts.setHandler((_req, res) => json(res, 200, { name: "new-s3", type: "aws" }));
    await client.connections.create({
      name: "new-s3",
      type: "aws",
      credentials: { access_key_id: "AKIA...", secret_access_key: "wJalr..." },
    });
    expect(ts.requests[0]).toMatchObject({ method: "POST", url: "/1/connections" });
    expect(ts.requests[0].body).toEqual({
      name: "new-s3",
      type: "aws",
      access_key_id: "AKIA...",
      secret_access_key: "wJalr...",
    });
  });

  it("supports get/list/delete", async () => {
    ts.setHandler((req, res) => {
      if (req.url === "/1/connections") {
        json(res, 200, { connections: [{ name: "my-aws-s3", type: "aws" }] });
      } else {
        json(res, 200, { name: "my-aws-s3", type: "aws" });
      }
    });
    const conn = await client.connections.get("my-aws-s3");
    expect(conn.name).toBe("my-aws-s3");
    const list = await client.connections.list();
    expect(list.map((c) => c.type)).toEqual(["aws"]);
    await client.connections.delete("my-aws-s3");
    expect(ts.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/1/connections/my-aws-s3" });
  });

  it("maps created_at to createdAt", async () => {
    ts.setHandler((_req, res) => json(res, 200, { name: "c", type: "github", created_at: "2026-01-01T00:00:00Z" }));
    const conn = await client.connections.get("c");
    expect(conn.createdAt).toBe("2026-01-01T00:00:00Z");
    expect("created_at" in conn).toBe(false);
  });
});

describe("cronjobs resource", () => {
  it("creates a cronjob with a snake_case wire payload", async () => {
    ts.setHandler((_req, res) =>
      json(res, 200, { id: "c1a92df4", name: "nightly-backup", cron_spec: "0 2 * * *", is_active: true }),
    );
    const cron = await client.cronjobs.create({
      name: "nightly-backup",
      cronSpec: "0 2 * * *",
      jobDefinition: { image: "alpine:latest", command: ["echo", "backup complete"] },
    });
    expect(cron.cronSpec).toBe("0 2 * * *");
    expect(cron.isActive).toBe(true);
    expect(ts.requests[0].body).toEqual({
      name: "nightly-backup",
      cron_spec: "0 2 * * *",
      is_active: true,
      job_definition: { image: "alpine:latest", command: ["echo", "backup complete"] },
    });
  });

  it("patches by name or id with snake_case wire fields", async () => {
    ts.setHandler((_req, res) => json(res, 200, { id: "c1", name: "nightly", cron_spec: "0 3 * * *", is_active: false }));
    await client.cronjobs.patch("nightly", { isActive: false, cronSpec: "0 3 * * *" });
    expect(ts.requests[0]).toMatchObject({ method: "PATCH", url: "/1/cronjobs/nightly" });
    expect(ts.requests[0].body).toEqual({ cron_spec: "0 3 * * *", is_active: false });

    await client.cronjobs.update("c1a92df4", { isActive: true });
    expect(ts.requests[1]).toMatchObject({ method: "PATCH", url: "/1/cronjobs/c1a92df4" });
    expect(ts.requests[1].body).toEqual({ is_active: true });
  });

  it("gets by unique name or UUID and lists cronjobs", async () => {
    ts.setHandler((req, res) => {
      if (req.url === "/1/cronjobs") {
        json(res, 200, { cronjobs: [{ id: "c1", name: "nightly", cron_spec: "0 2 * * *", is_active: true }] });
      } else {
        json(res, 200, { id: "c1", name: "nightly", cron_spec: "0 2 * * *", is_active: true });
      }
    });
    const byName = await client.cronjobs.get("nightly-backup");
    const byId = await client.cronjobs.get("c1a92df4-0000");
    expect(byName.cronSpec).toBe("0 2 * * *");
    expect(byId.isActive).toBe(true);
    expect(ts.requests[0].url).toBe("/1/cronjobs/nightly-backup");
    expect(ts.requests[1].url).toBe("/1/cronjobs/c1a92df4-0000");
    const list = await client.cronjobs.list();
    expect(list.map((c) => c.name)).toEqual(["nightly"]);
  });

  it("deletes by id or name", async () => {
    ts.setHandler((_req, res) => json(res, 200, {}));
    await client.cronjobs.delete("nightly-backup");
    expect(ts.requests[0]).toMatchObject({ method: "DELETE", url: "/1/cronjobs/nightly-backup" });
  });
});

describe("keys resource", () => {
  it("creates a key and returns the one-time token", async () => {
    ts.setHandler((_req, res) => json(res, 200, { name: "ci-key", api_key: "pat_123" }));
    const created = await client.keys.create({ name: "ci-key", role: "admin", expiresAt: "2026-12-31T00:00:00Z" });
    expect(created.apiKey).toBe("pat_123");
    expect(ts.requests[0].body).toEqual({ name: "ci-key", role: "admin", expires_at: "2026-12-31T00:00:00Z" });
  });

  it("lists and deletes keys", async () => {
    ts.setHandler((req, res) => {
      if (req.url === "/1/keys") json(res, 200, { keys: [{ name: "ci-key", role: "admin", created_at: "2026-01-01T00:00:00Z" }] });
      else json(res, 200, {});
    });
    const keys = await client.keys.list();
    expect(keys[0]).toMatchObject({ name: "ci-key", role: "admin", createdAt: "2026-01-01T00:00:00Z" });
    await client.keys.delete("ci-key");
    expect(ts.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/1/keys/ci-key" });
  });
});
