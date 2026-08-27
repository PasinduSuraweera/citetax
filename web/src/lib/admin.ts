/** Client for the admin API. Roles are enforced server side; this only shapes
 *  what the UI offers. */

import { API_BASE, ApiError, getToken } from "./api";

export type Role =
  | "free" | "individual" | "practice"
  | "reviewer" | "approver" | "admin" | "auditor";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  is_reviewer: boolean;
  can_approve: boolean;
}

export interface ProposalRow {
  id: string;
  rule_key: string | null;
  operation: string | null;
  value_json: Record<string, unknown> | null;
  confidence: number | null;
  status: string;
  priority: number;
  created_at: string;
  effective_from: string | null;
  effective_to: string | null;
  quoted_text: string | null;
  assigned_to: string | null;
  document_title: string | null;
  document_url: string | null;
  revision_no: number | null;
  supersedes_id: string | null;
  doc_type: string | null;
  is_revision_of_published: boolean;
  sla_hours: number;
  age_hours?: number;
  sla_breached?: boolean;
}

export interface PublishedVersion {
  id: string;
  value_json: Record<string, unknown>;
  effective_from: string;
  effective_to: string | null;
  citation_label: string | null;
  revision_no: number;
  quoted_text: string | null;
}

export interface ImpactCase {
  scenario: string;
  ya: string;
  old_balance: string | null;
  new_balance: string | null;
  delta: string | null;
  changed: boolean;
  old_must_file: boolean | null;
  new_must_file: boolean | null;
  obligation_flip: boolean;
  error: string | null;
}

export interface ImpactReport {
  total: number;
  changed: number;
  obligation_flips: number;
  min_delta: string | null;
  median_delta: string | null;
  max_delta: string | null;
  cases: ImpactCase[];
  errors: string[];
}

export interface SourceRow {
  source_id: string;
  name: string;
  index_url: string;
  discovery: string;
  doc_type: string;
  priority: string;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_change_at: string | null;
  document_count: number;
  days_since_change?: number | null;
  stale?: boolean;
}

export interface CrawlResult {
  source_id: string;
  links_found: number;
  new_documents: number;
  revisions: number;
  unchanged: number;
  errors: string[];
  documents: Array<{
    id: string;
    url: string;
    revision_no: number;
    is_revision: boolean;
    sha256: string;
  }>;
}

export interface CoverageRow {
  rule_key: string;
  years: Record<
    string,
    {
      state: "green" | "amber" | "red";
      citation?: string | null;
      effective_from?: string;
      effective_to?: string | null;
      error?: string;
    }
  >;
}

export interface CorpusHealth {
  snapshot: { id: string; label: string } | null;
  coverage: CoverageRow[];
  sources: SourceRow[];
  open_proposals: Array<{ priority: number; n: number; oldest: string }>;
  correction_rate: Array<{ field: string; n: number }>;
  totals: {
    proposals: number;
    rejected: number;
    published_versions: number;
    documents: number;
  };
}

export interface SnapshotRow {
  id: string;
  label: string;
  created_at: string;
  created_by: string | null;
  is_current: boolean;
  changelog: string | null;
  rule_count: number;
}

export interface AuditEvent {
  id: string;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before_json: unknown;
  after_json: unknown;
  at: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (!(init?.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_BASE}.`, 0);
  }

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = typeof body?.detail === "string" ? body.detail : undefined;
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }
  return res.json() as Promise<T>;
}

export const admin = {
  me: () => req<Me>("/admin/me"),

  proposals: (opts: { status?: string; onlyRevisions?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.onlyRevisions) q.set("only_revisions", "true");
    return req<{ proposals: ProposalRow[]; count: number; viewer_role: Role }>(
      `/admin/proposals${q.toString() ? `?${q}` : ""}`,
    );
  },

  proposal: (id: string) =>
    req<{
      proposal: ProposalRow & { raw_text?: string | null };
      published: PublishedVersion | null;
      is_value_bearing: boolean;
      viewer_role: Role;
    }>(`/admin/proposals/${id}`),

  editProposal: (id: string, body: Record<string, unknown>) =>
    req<{ ok: boolean; corrections_recorded: number }>(
      `/admin/proposals/${id}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  impact: (id: string) =>
    req<{ rule_key: string; impact: ImpactReport }>(
      `/admin/proposals/${id}/impact`,
      { method: "POST" },
    ),

  approve: (id: string) =>
    req<{
      ok: boolean;
      status: string;
      awaiting_second: boolean;
      first_approver?: string;
      second_approver?: string;
      message?: string;
    }>(`/admin/proposals/${id}/approve`, { method: "POST", body: "{}" }),

  reject: (id: string, reason: string) =>
    req<{ ok: boolean; status: string }>(`/admin/proposals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  publish: (changelog: string, label?: string) =>
    req<{
      ok: boolean;
      snapshot_id: string;
      label: string;
      changelog: string;
      published: Array<{ rule_key: string; rule_version_id: string }>;
    }>("/admin/snapshots/publish", {
      method: "POST",
      body: JSON.stringify({ changelog, label }),
    }),

  snapshots: () => req<{ snapshots: SnapshotRow[] }>("/admin/snapshots"),

  rollback: (id: string) =>
    req<{ ok: boolean; label: string; affected_rule_keys: string[] }>(
      `/admin/snapshots/${id}/rollback`,
      { method: "POST" },
    ),

  health: () => req<CorpusHealth>("/admin/health/corpus"),

  audit: (limit = 100) => req<{ events: AuditEvent[] }>(`/admin/audit?limit=${limit}`),

  escalations: () => req<{ escalations: Array<Record<string, unknown>> }>(
    "/admin/escalations",
  ),

  sources: () =>
    req<{ sources: SourceRow[]; recent_crawls: Array<Record<string, unknown>> }>(
      "/admin/sources",
    ),

  crawl: (sourceId: string) =>
    req<CrawlResult>(`/admin/sources/${sourceId}/crawl`, { method: "POST" }),

  crawlAll: () =>
    req<{ results: CrawlResult[]; total_new: number; total_revisions: number }>(
      "/admin/sources/crawl-all",
      { method: "POST" },
    ),

  documents: () =>
    req<{
      families: Array<{
        family_id: string;
        latest_revision: number;
        has_revisions: boolean;
        revisions: Array<{
          id: string;
          revision_no: number;
          url: string;
          title: string | null;
          fetched_at: string;
          sha256: string | null;
          supersedes_id: string | null;
          uploaded_by: string | null;
        }>;
      }>;
    }>("/admin/sources/documents"),

  upload: async (file: File, docType: string, title: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("doc_type", docType);
    form.append("title", title);
    return req<{
      ok: boolean;
      document_id: string;
      proposal_id: string;
      is_revision: boolean;
      sha256: string;
    }>("/admin/sources/upload", { method: "POST", body: form });
  },

  users: () =>
    req<{
      users: Array<{
        id: string;
        email: string;
        name: string | null;
        role: Role;
        created_at: string;
        last_seen_at: string | null;
      }>;
    }>("/admin/users"),

  setRole: (userId: string, role: Role) =>
    req<{ ok: boolean; email: string; role: Role }>(`/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
};

export const PRIORITY_LABEL: Record<number, string> = {
  1: "Revision of a published rule",
  2: "Rate, band or threshold",
  3: "Deadline",
  4: "New rule",
  5: "Editorial",
};
