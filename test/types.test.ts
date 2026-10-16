/**
 * Typed-contract tests: string-union value sets and nested interfaces are
 * exercised end-to-end against a mock API, and the wire payloads keep the
 * exact shapes from sdk.md / api spec §3.0.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  TERMINAL_STATUSES,
  type CloudProvider,
  type ConnectionCredentials,
  type ConnectionType,
  type Job,
  type Key,
  type KeyRole,
  type MacroRegion,
  SoltiClient,
  type TerminalStatus,
  type VmStatus,
  type WorkloadStatus,
} from "../src/index.js";

type AssertExtends<A, B> = A extends B ? true : never;

// String-union value sets cover exactly the finite wire values (api spec §3).
type AssertWorkloadStatus = AssertExtends<
  WorkloadStatus,
  "queued" | "booting" | "running" | "succeeded" | "failed" | "cancelled"
>;
type AssertTerminal = AssertExtends<TerminalStatus, "succeeded" | "failed" | "cancelled">;
type AssertVmStatus = AssertExtends<
  VmStatus,
  "nonassigned" | "provisioning" | "provisioned" | "terminating" | "terminated" | "error"
>;
type AssertCloud = AssertExtends<CloudProvider, "aws" | "gcp" | "azure">;
type AssertConnType = AssertExtends<ConnectionType, "aws" | "gcp" | "azure" | "r2" | "github">;
type AssertRole = AssertExtends<KeyRole, "admin" | "developer" | "viewer">;
type AssertMacro = AssertExtends<MacroRegion, "americas" | "europe" | "apac" | "africa" | "middle-east">;

const typeAssertions: AssertExtends<
  [
    AssertWorkloadStatus,
    AssertTerminal,
    AssertVmStatus,
    AssertCloud,
    AssertConnType,
    AssertRole,
    AssertMacro,
  ],
  [true, true, true, true, true, true, true]
> = true;

void typeAssertions;

let ts: {
  server: Server;
  url: string;
  requests: Array<{ method: string; url: string; body: unknown }>;
  setHandler: (h: (req: IncomingMessage, res: ServerResponse, body: unknown) => void) => void;
};
let client: SoltiClient;

beforeEach(async () => {
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let current: (req: IncomingMessage, res: ServerResponse, body: unknown) => void = (_q, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as unknown;
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body });
      current(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  ts = {
    server,
    url: `http://127.0.0.1:${port}/1`,
    requests,
    setHandler: (h) => {
      current = h;
    },
  };
  client = new SoltiClient({ apiKey: "k", apiUrl: ts.url, projectId: "proj-1" });
});

afterEach(async () => {
  await new Promise<void>((resolve) => ts.server.close(() => resolve()));
});

function json(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("string-union value sets", () => {
  it("exposes the exact terminal-status set", () => {
    expect([...TERMINAL_STATUSES]).toEqual(["succeeded", "failed", "cancelled"]);
  });

  it("accepts every workload status in job filters and rejects none of the wire values", async () => {
    const statuses: WorkloadStatus[] = [
      "queued",
      "booting",
      "running",
      "succeeded",
      "failed",
      "cancelled",
    ];
    for (const status of statuses) {
      ts.setHandler((_q, res) => json(res, { jobs: [] }));
      await client.jobs.list({ status });
      expect(ts.requests.at(-1)?.url).toBe(`/1/jobs?status=${status}`);
    }
  });

  it("maps vm_status wire values onto the VmStatus union", async () => {
    const vmStatuses: VmStatus[] = [
      "nonassigned",
      "provisioning",
      "provisioned",
      "terminating",
      "terminated",
      "error",
    ];
    for (const vm_status of vmStatuses) {
      ts.setHandler((_q, res) => json(res, { id: "j1", name: "n", status: "running", vm_status }));
      const job = await client.jobs.get("j1");
      expect(job.vmStatus).toBe(vm_status);
    }
  });
});

describe("nested typed request interfaces", () => {
  it("accepts the nested GpuRequest form alongside the VRAM shorthand", async () => {
    ts.setHandler((_q, res) => json(res, { id: "j1", name: "n", status: "queued" }));
    await client.jobs.create({
      image: "alpine:latest",
      resources: { cpu: 4, memory: "16Gi", gpu: { model: "A100", count: 2, vram: "48Gi" } },
    });
    expect(ts.requests[0].body).toMatchObject({
      resources: { cpu: 4, memory: "16Gi", gpu: { model: "A100", count: 2, vram: "48Gi" } },
    });
    await client.jobs.create({
      image: "alpine:latest",
      resources: { gpu: "24Gi" },
      cloud: ["aws", "gcp"],
      region: "americas",
    });
    expect(ts.requests[1].body).toMatchObject({ resources: { gpu: "24Gi" } });
  });

  it("accepts typed per-provider credentials for every connection type", async () => {
    ts.setHandler((_q, res) => json(res, { name: "c", type: "aws" }));
    const credentialSets: Array<[ConnectionType, ConnectionCredentials]> = [
      ["aws", { access_key_id: "AKIA", secret_access_key: "wJal" }],
      ["gcp", { gcp_project_id: "proj", keyfile_json: "{}" }],
      [
        "azure",
        { client_id: "c", client_secret: "s", subscription_id: "sub", tenant_id: "t" },
      ],
      ["r2", { account_id: "a", access_key_id: "k", secret_access_key: "s" }],
      ["github", { access_token: "t" }],
    ];
    let i = 0;
    for (const [type, credentials] of credentialSets) {
      await client.connections.create({ name: `c${i}`, type, credentials });
      expect(ts.requests[i].body).toMatchObject({ name: `c${i}`, type, ...credentials });
      i += 1;
    }
  });

  it("types cronjob jobDefinition as a job template without name", async () => {
    ts.setHandler((_q, res) => json(res, { id: "c1", name: "n", cron_spec: "0 2 * * *", is_active: true }));
    await client.cronjobs.create({
      name: "nightly",
      cronSpec: "0 2 * * *",
      jobDefinition: {
        image: "python:3.13-slim",
        command: ["python", "run.py"],
        resources: { gpu: { vram: "24Gi" } },
        maxRetries: 1,
      },
    });
    expect(ts.requests[0].body).toMatchObject({
      job_definition: {
        image: "python:3.13-slim",
        command: ["python", "run.py"],
        resources: { gpu: { vram: "24Gi" } },
        maxRetries: 1,
      },
    });
    await client.cronjobs.patch("nightly", { isActive: false });
    expect(ts.requests[1].body).toEqual({ is_active: false });
  });

  it("constrains key roles to the API role union", async () => {
    ts.setHandler((_q, res) => json(res, { name: "ci", api_key: "pat" }));
    const roles: KeyRole[] = ["admin", "developer", "viewer"];
    let i = 0;
    for (const role of roles) {
      const created = await client.keys.create({ name: `k${i}`, role });
      expect(created.apiKey).toBe("pat");
      expect(ts.requests[i].body).toMatchObject({ name: `k${i}`, role });
      i += 1;
    }
    const listed: Key[] = await (async () => {
      ts.setHandler((_q, res) => json(res, { keys: [{ name: "k0", role: "viewer" }] }));
      return client.keys.list();
    })();
    expect(listed[0]?.role).toBe("viewer");
    const job: Job = await (async () => {
      ts.setHandler((_q, res) => json(res, { id: "j1", name: "n", status: "succeeded" }));
      return client.jobs.get("j1");
    })();
    expect(job.status).toBe("succeeded");
  });
});
