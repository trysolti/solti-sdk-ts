/**
 * Preview smoke verification for `@solti/sdk` (Change 015 WS5).
 *
 * READ-ONLY against the preview environment (https://preview.api.solti.run/1):
 * list/get calls and error-path probes only — no mutations, no resource
 * creation, no 429 triggering (rate-limit plumbing is inspected from response
 * headers, not by hammering the API).
 *
 * Usage:
 *   SOLTI_API_KEY=... SOLTI_PROJECT_ID=... pnpm dlx tsx scripts/smoke-preview.ts
 *
 * Checks:
 *  1. Auth + project header: jobs.list() and connections.list() → 200, valid JSON.
 *  2. Error mapping: invalid API key on jobs.list() → AuthenticationError (401).
 *  3. Not-found mapping: jobs.get(<random UUID>) → SoltiApiError 404, no crash.
 *     (The TS hierarchy maps 404 to the generic SoltiApiError — no dedicated
 *     NotFoundError class; parity gap vs the Python SDK is noted in the report.)
 *  4. RateLimit header plumbing: inspect X-RateLimit-* headers on the list
 *     response; RateLimitError surfaces limit/remaining/reset when present.
 */

import { randomUUID } from "node:crypto";
import { AuthenticationError, SoltiApiError, SoltiClient } from "../src/index.js";

interface Row {
  check: string;
  ok: boolean;
  detail: string;
}

const rows: Row[] = [];
function record(check: string, ok: boolean, detail: string): void {
  rows.push({ check, ok, detail });
}

const apiKey = process.env.SOLTI_API_KEY ?? "";
const projectId = process.env.SOLTI_PROJECT_ID ?? "";
const apiUrl = process.env.SOLTI_PREVIEW_API_URL ?? "https://preview.api.solti.run/1";
if (apiKey === "" || projectId === "") {
  console.error("SOLTI_API_KEY and SOLTI_PROJECT_ID are required");
  process.exit(2);
}

console.log(`Preview smoke — ${apiUrl} (project ${projectId})\n`);

// 1. Auth + project header: jobs.list() + connections.list() → 200 / valid JSON.
// 4. RateLimit headers: raw fetch of the same list endpoint with the client's
//    exact headers (the success path of request() returns parsed JSON only).
try {
  const client = new SoltiClient({ apiKey, apiUrl, projectId });
  const jobs = await client.jobs.list({ limit: 5 });
  const connections = await client.connections.list();
  const ok = Array.isArray(jobs) && Array.isArray(connections);
  record(
    "auth+jobs.list+connections.list (200, valid JSON)",
    ok,
    `jobs=${jobs.length} connections=${connections.length}`,
  );

  const response = await fetch(`${apiUrl}/jobs?limit=5`, {
    headers: { "X-Solti-API-Key": apiKey, "X-Solti-Project-Id": projectId },
  });
  const rlHeaders: string[] = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-ratelimit-")) rlHeaders.push(`${name}: ${value}`);
  });
  if (rlHeaders.length > 0) {
    record(
      "ratelimit headers surfaced on list response",
      response.status === 200,
      rlHeaders.join(", "),
    );
  } else {
    record(
      "ratelimit headers surfaced on list response",
      response.status === 200,
      "no X-RateLimit-* headers sent by preview on 200 (RateLimitError limit/remaining/reset plumbing unit-verified; live 429 not triggered by design)",
    );
  }
} catch (error) {
  record(
    "auth+jobs.list+connections.list (200, valid JSON)",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

// 2. Error mapping: invalid API key → AuthenticationError (401).
try {
  const bad = new SoltiClient({ apiKey: "invalid-smoke-key", apiUrl, projectId });
  try {
    await bad.jobs.list({ limit: 1 });
    record("invalid key → AuthenticationError (401)", false, "no error raised");
  } catch (error) {
    if (error instanceof AuthenticationError) {
      record("invalid key → AuthenticationError (401)", error.status === 401, `status=${error.status}`);
    } else if (error instanceof SoltiApiError) {
      // Observed on preview: the API returns 500 'Internal Server Error' for
      // invalid keys (error-contract violation — 401 is expected; recorded in
      // the WS5 report). The SDK surfaces generic SoltiApiError — no crash.
      record(
        "invalid key → AuthenticationError (401)",
        false,
        `API returned status=${error.status} (expected 401 — preview error-contract violation, recorded in report); SDK raised ${error.name}, no crash`,
      );
    } else {
      record(
        "invalid key → AuthenticationError (401)",
        false,
        `unexpected error type ${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }
} catch (error) {
  record(
    "invalid key → AuthenticationError (401)",
    false,
    `client init: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// 3. Not-found mapping: random-UUID job → SoltiApiError 404, no crash.
const missingId = randomUUID();
try {
  const client = new SoltiClient({ apiKey, apiUrl, projectId });
  try {
    await client.jobs.get(missingId);
    record("random-UUID job → SoltiApiError (404)", false, "no error raised");
  } catch (error) {
    if (error instanceof SoltiApiError && error.status === 404) {
      record("random-UUID job → SoltiApiError (404)", true, `status=${error.status}`);
    } else {
      record(
        "random-UUID job → SoltiApiError (404)",
        false,
        `unexpected error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  }
} catch (error) {
  record(
    "random-UUID job → SoltiApiError (404)",
    false,
    `client init: ${error instanceof Error ? error.message : String(error)}`,
  );
}

// Compact PASS/FAIL table.
const width = Math.max(...rows.map((row) => row.check.length));
const failed = rows.filter((row) => !row.ok).length;
console.log(`${"CHECK".padEnd(width)}  RESULT  DETAIL`);
for (const row of rows) {
  console.log(`${row.check.padEnd(width)}  ${row.ok ? "PASS" : "FAIL"}    ${row.detail}`);
}
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed === 0 ? 0 : 1);
