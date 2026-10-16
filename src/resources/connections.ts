/**
 * Connections resource — CRUD for cloud/storage credential integrations
 * (api spec §3.1). Credentials are write-only: the API stores them encrypted
 * and redacts them on read.
 *
 * Wire payload follows ../solti-cli/src/commands/connection.ts: credential
 * fields are sent flat at the top level (`access_key_id`, `access_token`, …).
 * The SDK accepts them nested under `credentials` and flattens for the wire.
 */

import type { SoltiClient } from "../client.js";
import { rawString, type RawRecord } from "./shared.js";

export interface Connection {
  name: string;
  type: string;
  createdAt?: string;
  /** Remaining provider-specific fields (credentials are redacted by the API). */
  [key: string]: unknown;
}

export interface ConnectionCreateRequest {
  name: string;
  /** e.g. `"aws" | "gcp" | "azure" | "r2" | "github"`. */
  type: string;
  /** Provider credential fields, flattened into the wire payload (CLI convention). */
  credentials?: Record<string, unknown>;
  /** Flat credential fields are also accepted directly (CLI convention). */
  [key: string]: unknown;
}

function mapConnection(raw: RawRecord): Connection {
  const { created_at: createdAt, ...rest } = raw;
  return {
    ...rest,
    name: rawString(raw, "name") ?? "",
    type: rawString(raw, "type") ?? "",
    createdAt: createdAt as string | undefined,
  };
}

export class ConnectionsResource {
  constructor(private readonly client: SoltiClient) {}

  async create(request: ConnectionCreateRequest): Promise<Connection> {
    const { credentials, ...flat } = request;
    const body = { ...flat, ...credentials };
    const raw = (await this.client.request("connections", { method: "POST", body })) as RawRecord;
    return mapConnection(raw);
  }

  async get(name: string): Promise<Connection> {
    const raw = (await this.client.request(`connections/${encodeURIComponent(name)}`)) as RawRecord;
    return mapConnection(raw);
  }

  async list(): Promise<Connection[]> {
    const data = (await this.client.request("connections")) as { connections?: RawRecord[] } | RawRecord[];
    const items = Array.isArray(data) ? data : (data.connections ?? []);
    return items.map(mapConnection);
  }

  async delete(name: string): Promise<void> {
    await this.client.request(`connections/${encodeURIComponent(name)}`, { method: "DELETE" });
  }
}
