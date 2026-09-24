/**
 * Client for citetax-api.
 *
 * Money crosses the wire as a string and stays a string until it is formatted
 * for display. Parsing it into a JS number would reintroduce exactly the
 * float imprecision the Decimal engine exists to avoid.
 */

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8000";

export type Badge = "all_cited" | "partial" | "cannot_answer";

export interface LedgerStep {
  step_no: number;
  label: string;
  rule_key: string;
  rule_version_id: string | null;
  citation_label: string | null;
  value: string;
  is_zero: boolean;
  detail: Record<string, unknown> | null;
}

export interface BandRow {
  from: string;
  to: string;
  rate: string;
  amount: string;
  tax: string;
}

export interface Citation {
  rule_key: string;
  rule_version_id: string;
  label: string | null;
  revision_no: number;
  effective_from: string;
  effective_to: string | null;
  supersedes_version_id: string | null;
  quoted_text: string | null;
  value?: Record<string, unknown>;
}

export interface TraceEntry {
  node: string;
  status: "ok" | "refused" | "skipped" | "failed" | "planned";
  detail: string | null;
  ms: number;
}

export type Intent =
  | "compute" | "obligation" | "deadline" | "compare"
  | "rule_lookup" | "general" | "out_of_scope";

export interface Compliance {
  must_file: boolean;
  reason: string;
  return_due: string | null;
  instalments: string[];
  rule_version_id: string | null;
  citation_label: string | null;
  days_remaining?: number | null;
}

export interface Passage {
  chunk_id: string;
  text: string;
  source_document_id: string | null;
  rule_key: string | null;
  title: string | null;
  url: string | null;
  score: number;
  matched_by: "fts" | "dense" | "both";
}

export interface LlmUsage {
  calls: Array<{
    model: string;
    called: boolean;
    ok: boolean;
    ms: number;
    tokens: { in: number; out: number };
    finish_reason: string | null;
    error: string | null;
  }>;
  total_tokens: number;
  total_ms: number;
}

export interface CompareChange {
  rule_key: string;
  title?: string;
  changed: boolean;
  same_version?: boolean;
  from: RuleSide;
  to: RuleSide;
}

export interface RuleSide {
  value: Record<string, unknown>;
  rule_version_id: string;
  citation_label: string | null;
  effective_from?: string;
  effective_to?: string | null;
  quoted_text?: string | null;
}

export interface VerifyResult {
  badge: Badge;
  ok: boolean;
  unmatched_numbers: string[];
  pii_classes: string[];
  prose_released: boolean;
  note: string | null;
  checked_numbers?: number;
}

export interface Snapshot {
  id: string;
  label: string;
  changelog: string | null;
  created_at?: string | null;
}

export interface AnswerResponse {
  kind: "answer" | "refusal" | "clarify";
  intent: Intent;
  plan: string[];
  route_source: "llm" | "regex";
  badge: Badge;
  ya: string | null;
  snapshot: Snapshot | null;
  trace: TraceEntry[];
  latency_ms: number;
  llm?: LlmUsage;
  run_id?: string | null;
  computation?: {
    steps: LedgerStep[];
    balance_payable: string;
    taxable_income: string;
    gross_tax: string;
    is_refund: boolean;
    step_count: number;
  };
  compliance?: Compliance;
  compare?: {
    from_ya: string;
    to_ya: string;
    changed_count: number;
    changes: CompareChange[];
  };
  lookup?: Citation[];
  passages?: Passage[];
  explanation?: string | null;
  verify?: VerifyResult | null;
  citations?: Citation[];
  refusal?: { reason: string; pointer: string | null; category?: string | null };
  clarify?: { question: string };

  /* Signed in only: the conversation this turn was saved to. */
  conversation_id?: string | null;
  conversation?: ConversationSummary;
  conversation_created?: boolean;
  message_id?: string;
  question_message_id?: string;
  seq?: number;
  /** The question as stored, which is redacted. A reload shows this. */
  user_message?: string;
  message_persisted?: boolean;

  /* On a stored answer: whether the snapshot it ran against is still the
     current one, and whether it can be asked again with its stored facts. */
  snapshot_is_current?: boolean | null;
  reaskable?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ConversationTurn {
  seq: number;
  question: { id: string; content: string; created_at: string | null };
  reply: {
    id: string;
    seq: number;
    kind: AnswerResponse["kind"];
    created_at: string | null;
    answer: AnswerResponse;
  } | null;
}

export interface ConversationPage {
  conversation: ConversationSummary;
  turns: ConversationTurn[];
  has_more: boolean;
  before_seq: number | null;
  current_snapshot_id: string | null;
}

export interface ComputeResponse {
  ya: string;
  steps: LedgerStep[];
  balance_payable: string;
  taxable_income: string;
  gross_tax: string;
  is_refund: boolean;
  compliance: Compliance;
  corpus_snapshot_id: string;
}

export interface CompareResponse {
  from_ya: string;
  to_ya: string;
  changed_count: number;
  changes: CompareChange[];
  corpus_snapshot_id: string;
  snapshot_history: Array<{
    label: string;
    changelog: string | null;
    created_at: string | null;
  }>;
}

export interface DeadlinesResponse {
  ya: string;
  return_due: string | null;
  days_remaining: number | null;
  instalments: string[];
  citation: {
    label: string | null;
    rule_version_id: string;
    effective_from: string;
    quoted_text: string | null;
  };
}

export interface ObligationResponse extends Compliance {
  ya: string;
  taxable_income: string;
  corpus_snapshot_id: string;
}

export interface PayslipExtractResponse {
  ya: string;
  source: "payslip";
  confidence: number;
  pay_period: "monthly" | "annual" | null;
  fields: {
    employment_income?: string;
    epf_employee?: string;
    apit_withheld?: string;
  };
  warnings: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Bearer token cache.
 *
 * /api/token mints a one hour token from the session cookie. Caching it avoids
 * a round trip per API call; it is refreshed a minute before expiry so a call
 * never goes out with a token that expires in flight.
 */
let tokenCache: { value: string; expiresAt: number } | null = null;

export async function getToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  try {
    const res = await fetch("/api/token", { cache: "no-store" });
    if (!res.ok) {
      tokenCache = null;
      return null;
    }
    const { token } = (await res.json()) as { token: string | null };
    if (!token) return null;
    tokenCache = { value: token, expiresAt: Date.now() + 59 * 60 * 1000 };
    return token;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  tokenCache = null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    // A FormData body needs the browser to set its own multipart boundary —
    // forcing JSON here would break every upload call.
    ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
    ...(init?.headers as Record<string, string>),
  };

  // Server components have no /api/token to call and no cookie jar here, so
  // token attachment is a browser-only concern.
  if (typeof window !== "undefined") {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      `Cannot reach the Citetax API at ${API_BASE}. Is it running?`,
      0,
    );
  }

  if (!res.ok) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = typeof body?.detail === "string" ? body.detail : undefined;
    } catch {
      /* body was not JSON; the status alone has to carry the message */
    }
    throw new ApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }

  // 204 No Content has no body to parse.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface StreamStep {
  node: string;
  status: TraceEntry["status"];
  detail: string | null;
  ms: number;
}

/**
 * Same question-in, answer-out contract as api.ask, except onStep fires the
 * instant each step actually finishes on the backend — not a guess, not a
 * timer. onPlan fires once, when Route has chosen the steps still to come.
 * Plain fetch() reading the body as a stream, not EventSource: a browser's
 * native EventSource cannot attach the Authorization header this API needs,
 * and NDJSON over POST has no such limitation.
 */
async function askStream(
  question: string,
  ya: string | undefined,
  onStep: (step: StreamStep) => void,
  opts: {
    conversationId?: string | null;
    reaskMessageId?: string | null;
    onPlan?: (plan: string[]) => void;
  } = {},
): Promise<AnswerResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof window !== "undefined") {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/v1/ask/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question,
        ya: ya ?? null,
        conversation_id: opts.conversationId ?? null,
        reask_message_id: opts.reaskMessageId ?? null,
      }),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(`Cannot reach the Citetax API at ${API_BASE}. Is it running?`, 0);
  }
  if (!res.ok || !res.body) {
    let detail: string | undefined;
    try {
      const body = await res.json();
      detail = typeof body?.detail === "string" ? body.detail : undefined;
    } catch {
      /* body was not JSON; the status alone has to carry the message */
    }
    throw new ApiError(detail ?? `Request failed (${res.status})`, res.status, detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineAt).trim();
      buffer = buffer.slice(newlineAt + 1);
      if (!line) continue;

      const event = JSON.parse(line) as
        | ({ type: "step" } & StreamStep)
        | { type: "plan"; plan: string[] }
        | { type: "done"; payload: AnswerResponse }
        | { type: "error"; message: string; status?: number };

      if (event.type === "step") {
        onStep(event);
      } else if (event.type === "plan") {
        opts.onPlan?.(event.plan);
      } else if (event.type === "done") {
        return event.payload;
      } else {
        // A refused request (404, 409) keeps its status; an unexpected
        // failure inside the run has none and reads as a generic error.
        throw new ApiError(event.message, event.status ?? 500);
      }
    }
  }

  throw new ApiError("The stream ended without a result.", 0);
}

export const api = {
  /**
   * Signed in, a question is saved as a turn: in `conversationId`, or in a new
   * conversation when it is omitted. `reaskMessageId` asks an answered turn
   * again with its stored facts, against the current snapshot.
   */
  ask: (
    question: string,
    ya?: string,
    opts: { conversationId?: string | null; reaskMessageId?: string | null } = {},
  ) =>
    request<AnswerResponse>("/v1/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        ya: ya ?? null,
        conversation_id: opts.conversationId ?? null,
        reask_message_id: opts.reaskMessageId ?? null,
      }),
    }),

  conversations: (cursor?: string | null, limit = 20) =>
    request<{ conversations: ConversationSummary[]; next_cursor: string | null }>(
      `/v1/conversations?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),

  conversation: (id: string, beforeSeq?: number | null, turns = 10) =>
    request<ConversationPage>(
      `/v1/conversations/${encodeURIComponent(id)}?turns=${turns}${
        beforeSeq ? `&before_seq=${beforeSeq}` : ""
      }`,
    ),

  renameConversation: (id: string, title: string) =>
    request<ConversationSummary>(`/v1/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteConversation: (id: string) =>
    request<void>(`/v1/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),

  askStream,

  compute: (body: Record<string, string>) =>
    request<ComputeResponse>("/v1/compute", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  payslipExtract: (file: File, ya: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("ya", ya);
    return request<PayslipExtractResponse>("/v1/payslip/extract", {
      method: "POST",
      body: form,
    });
  },

  snapshot: () => request<Snapshot>("/v1/snapshot/current"),

  history: () =>
    request<{
      runs: Array<{
        id: string;
        ya: string;
        intent: Intent | null;
        question: string | null;
        balance_payable: string | null;
        taxable_income: string | null;
        step_count: number | null;
        is_refund: boolean | null;
        latency_ms: number | null;
        created_at: string | null;
        snapshot_label: string | null;
        badge: string | null;
      }>;
      count: number;
    }>("/v1/history"),

  historyDetail: (id: string) =>
    request<{
      id: string;
      ya: string;
      intent: Intent | null;
      plan: string[] | null;
      question: string | null;
      ledger: AnswerResponse["computation"] | null;
      facts: Record<string, unknown> | null;
      answer_text: string | null;
      verify_result: VerifyResult | null;
      llm_usage: LlmUsage | null;
      latency_ms: number | null;
      model: string | null;
      created_at: string | null;
      snapshot: { id: string | null; label: string | null; changelog: string | null };
    }>(`/v1/history/${id}`),

  deadlines: (ya: string) =>
    request<DeadlinesResponse>(`/v1/deadlines?ya=${encodeURIComponent(ya)}`),

  obligation: (ya: string, income: string, apit = "0") =>
    request<ObligationResponse>(
      `/v1/obligation?ya=${encodeURIComponent(ya)}&income=${income}&apit=${apit}`,
    ),

  compare: (from: string, to: string) =>
    request<CompareResponse>(
      `/v1/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),

  rule: (ruleKey: string, ya: string) =>
    request<Record<string, unknown>>(
      `/v1/rules/${encodeURIComponent(ruleKey)}?ya=${encodeURIComponent(ya)}`,
    ),

  flag: (runId: string, body: Record<string, unknown>) =>
    request<{ escalation_id: string; status: string }>(
      `/v1/runs/${runId}/flag`,
      { method: "POST", body: JSON.stringify(body) },
    ),
};

/* ---------- formatting ---------- */

/** Format a decimal string as money without ever going through a float. */
export function money(value: string, opts: { decimals?: boolean } = {}): string {
  const negative = value.startsWith("-");
  const raw = negative ? value.slice(1) : value;
  const [whole, frac = ""] = raw.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const showDecimals = opts.decimals ?? frac.replace(/0+$/, "") !== "";
  const out = showDecimals ? `${grouped}.${frac.padEnd(2, "0").slice(0, 2)}` : grouped;
  return negative ? `-${out}` : out;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function percent(rate: string): string {
  const n = Number(rate) * 100;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}
