/**
 * Keys resource — API key management (admin-only; api spec §3.4). Proxies
 * Zitadel machine users / PATs. The clear-text token is returned exactly once
 * at creation.
 */

import type { SoltiClient } from "../client.js";
import { rawString, type RawRecord } from "./shared.js";

export interface Key {
  name: string;
  role?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface CreateKeyRequest {
  name: string;
  /** Role assigned to the machine user (e.g. `viewer`, `admin`). */
  role: string;
  /** Optional expiry (ISO 8601). */
  expiresAt?: string;
}

export interface CreateKeyResponse {
  name: string;
  /** Clear-text PAT, shown only once. */
  apiKey?: string;
  /** Alternate wire key for the same token. */
  token?: string;
}

function mapKey(raw: RawRecord): Key {
  const { created_at: createdAt, ...rest } = raw;
  return {
    ...rest,
    name: rawString(raw, "name") ?? "",
    role: rawString(raw, "role"),
    createdAt: createdAt as string | undefined,
  };
}

export class KeysResource {
  constructor(private readonly client: SoltiClient) {}

  async create(request: CreateKeyRequest): Promise<CreateKeyResponse> {
    const body: Record<string, unknown> = { name: request.name, role: request.role };
    if (request.expiresAt !== undefined) body.expires_at = request.expiresAt;
    const raw = (await this.client.request("keys", { method: "POST", body })) as RawRecord;
    return {
      name: rawString(raw, "name") ?? "",
      apiKey: rawString(raw, "api_key"),
      token: rawString(raw, "token"),
    };
  }

  async list(): Promise<Key[]> {
    const data = (await this.client.request("keys")) as { keys?: RawRecord[] } | RawRecord[];
    const items = Array.isArray(data) ? data : (data.keys ?? []);
    return items.map(mapKey);
  }

  /** Accepts either the key UUID or the key name. */
  async delete(idOrName: string): Promise<void> {
    await this.client.request(`keys/${encodeURIComponent(idOrName)}`, { method: "DELETE" });
  }
}
