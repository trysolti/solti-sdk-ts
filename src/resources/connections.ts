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
import { rawUnion, rawString, type ConnectionType, type RawRecord } from "./shared.js";

/** `type: "aws"` credential fields (cli wire format). */
export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  region?: string;
}

/** `type: "gcp"` credential fields (cli wire format). */
export interface GcpCredentials {
  gcp_project_id: string;
  /** Service-account key JSON (stringified) or omitted for ADC-style creds. */
  keyfile_json?: string;
}

/** `type: "azure"` credential fields (cli wire format). */
export interface AzureCredentials {
  client_id: string;
  client_secret: string;
  subscription_id: string;
  tenant_id: string;
}

/** `type: "r2"` (Cloudflare R2) credential fields (cli wire format). */
export interface R2Credentials {
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
}

/** `type: "github"` credential fields (cli wire format). */
export interface GithubCredentials {
  access_token: string;
}

/** Provider-specific credentials, flattened into the wire payload (cli convention). */
export type ConnectionCredentials =
  | AwsCredentials
  | GcpCredentials
  | AzureCredentials
  | R2Credentials
  | GithubCredentials;

/** A stored connection (credentials are redacted by the API on read). */
export interface Connection {
  name: string;
  type: ConnectionType;
  createdAt?: string;
  /** Remaining provider-specific fields (credentials are redacted by the API). */
  [key: string]: unknown;
}

export interface ConnectionCreateRequest {
  name: string;
  type: ConnectionType;
  /** Provider credential fields, flattened into the wire payload (CLI convention). */
  credentials?: ConnectionCredentials;
  /** Flat credential fields are also accepted directly (CLI convention). */
  [key: string]: unknown;
}

function mapConnection(raw: RawRecord): Connection {
  const { created_at: createdAt, ...rest } = raw;
  return {
    ...rest,
    name: rawString(raw, "name") ?? "",
    type: rawUnion<ConnectionType>(raw, "type") ?? ("" as ConnectionType),
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
