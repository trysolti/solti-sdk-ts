/**
 * Workflows resource — DAG orchestration over job templates (api 0.3.0,
 * change 091 WS2). A workflow is a `templates` list, each entry a standard
 * job definition wired with `dependencies` edges referencing other template
 * names: root templates (no dependencies) provision immediately, dependents
 * wait for ALL upstream nodes. Fan-out via `withItems` (static list) or
 * `withSequence` (numeric range) materializes one node per item (≤50 nodes).
 *
 * Request payloads use camelCase wire keys (`namePrefix`, `withItems`,
 * `withSequence`); responses are snake_case and are mapped to camelCase SDK
 * types (`workflowId`, `nodeCount`, `ondemandCost`) exactly like `JobData`.
 */

import type { SoltiClient } from "../client.js";
import {
  rawNumber,
  rawString,
  rawUnion,
  type RawRecord,
  type VmStatus,
  type WorkloadStatus,
  type WorkflowStatus,
} from "./shared.js";
import type { JobDefinition } from "./jobs.js";

/**
 * Workflow-node job definition: `name`/`namePrefix`/`runAfter` are not
 * accepted — node identity comes from the template name (api spec
 * `WorkflowTemplate.job`).
 */
export type WorkflowJobDefinition = Omit<JobDefinition, "runAfter">;

/** Numeric fan-out range: one node per integer from `start` to `end` (inclusive), stepping by `step`. */
export interface WorkflowWithSequence {
  /** Inclusive range start. */
  start: number;
  /** Inclusive range end. */
  end: number;
  /** Step between items (minimum 1, default 1). */
  step?: number;
}

/** One DAG node template: a job definition plus optional dependency edges and static fan-out. */
export interface WorkflowTemplate {
  /** Node template name, unique within the workflow (slug charset, at most 63 characters). */
  name: string;
  /** Standard job definition for the node. */
  job: WorkflowJobDefinition;
  /** Upstream template names (absent = root node that provisions immediately). */
  dependencies?: string[];
  /** Static fan-out: one node per item with the literal `{{item}}` substituted into string values. */
  withItems?: string[];
  /** Numeric fan-out range (mutually exclusive with `withItems`). */
  withSequence?: WorkflowWithSequence;
}

export interface CreateWorkflowRequest {
  /** Optional unique workflow name (slug); 409 Conflict on collision. */
  name?: string;
  /** Optional prefix — generates a unique `<prefix>-<random suffix>` name. */
  namePrefix?: string;
  /** DAG node templates (the workflow materializes at most 50 node jobs). */
  templates: WorkflowTemplate[];
}

export interface WorkflowListFilters {
  status?: WorkflowStatus;
  /** Number of items to skip (default 0). */
  offset?: number;
  /** Page size (default 50). */
  limit?: number;
}

/** One materialized node-job reference on the create response (`nodes` map value). */
export interface WorkflowNodeRef {
  jobId: string;
  name: string;
}

/** One workflow node job (live projection of the jobs row on `get`). */
export interface WorkflowNodeData {
  jobId: string;
  name: string;
  status: WorkloadStatus;
  vmStatus?: VmStatus;
  errorMessage?: string;
  startedAt?: string;
  endedAt?: string;
  estimatedCost?: number;
  actualCost?: number;
  ondemandCost?: number;
}

/** Mapped workflow state (camelCase view of the snake_case API response). */
export interface WorkflowData {
  /** Unique workflow identifier (UUIDv7) — `workflow_id` wire key. */
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  organizationId?: string;
  projectId?: string;
  /** Workflow-level error summary (null/absent while running). */
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Terminal timestamp (absent while running). */
  endedAt?: string;
  /** Number of materialized node jobs (list rows). */
  nodeCount?: number;
  /** Materialized node jobs keyed by node-job name (create response). */
  nodes?: Record<string, WorkflowNodeRef>;
}

/** Mapped `get` response: the workflow fields plus live node jobs and aggregate costs. */
export interface WorkflowDetailData {
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  organizationId?: string;
  projectId?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  nodeCount?: number;
  /** Node jobs read live from the jobs rows (created_at, name order). */
  nodes: WorkflowNodeData[];
  /** Aggregate estimated cost over the nodes (absent when no node reports one). */
  estimatedCost?: number;
  actualCost?: number;
  ondemandCost?: number;
}

/** Paginated `list` response envelope (`ListWorkflowsResponse` wire shape). */
export interface WorkflowListData {
  workflows: WorkflowData[];
  /** Total number of workflows matching the filter. */
  total: number;
  offset: number;
  limit: number;
}

/** Maps a workflow row (`workflow_id` on create/cancel, `id` on list rows). */
export function mapWorkflow(raw: RawRecord): WorkflowData {
  const nodes = raw.nodes;
  const nodeMap: Record<string, WorkflowNodeRef> = {};
  if (typeof nodes === "object" && nodes !== null && !Array.isArray(nodes)) {
    for (const [nodeName, value] of Object.entries(nodes as RawRecord)) {
      const ref = value as RawRecord;
      nodeMap[nodeName] = {
        jobId: rawString(ref, "job_id") ?? rawString(ref, "id") ?? "",
        name: rawString(ref, "name") ?? nodeName,
      };
    }
  }
  return {
    workflowId: rawString(raw, "workflow_id") ?? rawString(raw, "id") ?? "",
    name: rawString(raw, "name") ?? "",
    status: rawUnion<WorkflowStatus>(raw, "status") ?? ("" as WorkflowStatus),
    organizationId: rawString(raw, "organization_id"),
    projectId: rawString(raw, "project_id"),
    errorMessage: rawString(raw, "error_message"),
    createdAt: rawString(raw, "created_at"),
    updatedAt: rawString(raw, "updated_at"),
    endedAt: rawString(raw, "ended_at"),
    nodeCount: rawNumber(raw, "node_count"),
    nodes: Object.keys(nodeMap).length > 0 ? nodeMap : undefined,
  };
}

function mapWorkflowNode(raw: RawRecord): WorkflowNodeData {
  return {
    jobId: rawString(raw, "job_id") ?? rawString(raw, "id") ?? "",
    name: rawString(raw, "name") ?? "",
    status: rawUnion<WorkloadStatus>(raw, "status") ?? ("" as WorkloadStatus),
    vmStatus: rawUnion<VmStatus>(raw, "vm_status"),
    errorMessage: rawString(raw, "error_message"),
    startedAt: rawString(raw, "started_at"),
    endedAt: rawString(raw, "ended_at"),
    estimatedCost: rawNumber(raw, "estimated_cost"),
    actualCost: rawNumber(raw, "actual_cost"),
    ondemandCost: rawNumber(raw, "ondemand_cost"),
  };
}

/** Maps the `get` detail response (live node jobs + aggregate cost sums). */
export function mapWorkflowDetail(raw: RawRecord): WorkflowDetailData {
  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as RawRecord[]) : [];
  return {
    workflowId: rawString(raw, "workflow_id") ?? rawString(raw, "id") ?? "",
    name: rawString(raw, "name") ?? "",
    status: rawUnion<WorkflowStatus>(raw, "status") ?? ("" as WorkflowStatus),
    organizationId: rawString(raw, "organization_id"),
    projectId: rawString(raw, "project_id"),
    errorMessage: rawString(raw, "error_message"),
    createdAt: rawString(raw, "created_at"),
    updatedAt: rawString(raw, "updated_at"),
    endedAt: rawString(raw, "ended_at"),
    nodeCount: rawNumber(raw, "node_count"),
    nodes: nodes.map(mapWorkflowNode),
    estimatedCost: rawNumber(raw, "estimated_cost"),
    actualCost: rawNumber(raw, "actual_cost"),
    ondemandCost: rawNumber(raw, "ondemand_cost"),
  };
}

export class WorkflowsResource {
  constructor(private readonly client: SoltiClient) {}

  /**
   * Submits a DAG workflow. Without `name`/`namePrefix` a unique Notion-like
   * name is auto-generated (e.g. `tidal-star-1234`).
   */
  async create(request: CreateWorkflowRequest): Promise<WorkflowData> {
    const raw = (await this.client.request("workflows", { method: "POST", body: request })) as RawRecord;
    return mapWorkflow(raw);
  }

  /** Accepts either the workflow's unique UUID or its unique name. */
  async get(idOrName: string): Promise<WorkflowDetailData> {
    const raw = (await this.client.request(`workflows/${encodeURIComponent(idOrName)}`)) as RawRecord;
    return mapWorkflowDetail(raw);
  }

  /** Lists workflows, newest first, with the paginated response envelope. */
  async list(filters: WorkflowListFilters = {}): Promise<WorkflowListData> {
    const data = (await this.client.request("workflows", {
      query: {
        status: filters.status,
        offset: filters.offset,
        limit: filters.limit,
      },
    })) as RawRecord;
    const items = Array.isArray(data.workflows) ? (data.workflows as RawRecord[]) : [];
    return {
      workflows: items.map(mapWorkflow),
      total: rawNumber(data, "total") ?? items.length,
      offset: rawNumber(data, "offset") ?? 0,
      limit: rawNumber(data, "limit") ?? items.length,
    };
  }

  /**
   * Cancels a running workflow (by UUID or name): every non-terminal node job
   * is cancelled; returns the workflow in its post-cancel status. 409 when
   * the workflow is already terminal.
   */
  async cancel(idOrName: string): Promise<WorkflowData> {
    const raw = (await this.client.request(
      `workflows/${encodeURIComponent(idOrName)}/cancel`,
      { method: "POST" },
    )) as RawRecord;
    return mapWorkflow(raw);
  }
}
