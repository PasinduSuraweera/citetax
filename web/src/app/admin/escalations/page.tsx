"use client";

/** User escalations (spec section 5.1 G). */

import { useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type Me } from "@/lib/admin";

interface Row {
  id: string;
  step_no: number | null;
  note: string | null;
  status: string;
  created_at: string;
  rule_key: string | null;
  citation_label: string | null;
  ya: string | null;
  corpus_snapshot_id: string | null;
  facts_redacted_json: Record<string, unknown> | null;
}

export default function EscalationsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const who = await admin.me();
        setMe(who);
        if (who.is_reviewer) {
          const r = await admin.escalations();
          setRows(r.escalations as unknown as Row[]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load escalations");
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;

  return (
    <AdminShell me={me}>
      <div className="px-9 py-8">
        <h1 className="text-[28px] font-semibold tracking-[-0.03em] text-ink-900">
          Escalations
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          A user flagged a computation step. Each flag carries the rule version
          and the inputs that produced the figure, so the answer can be
          reproduced exactly as it stood.
        </p>

        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {rows.length === 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-line-strong bg-white px-6 py-10 text-center">
            <div className="eyebrow">NOTHING FLAGGED</div>
            <p className="mx-auto mt-3 max-w-[400px] text-[13.5px] leading-[1.6] text-ink-400">
              No user has disputed a figure. Flags appear here bound to the rule
              version and run that produced them.
            </p>
          </div>
        ) : (
          <div className="mt-6 flex flex-col gap-3">
            {rows.map((r) => (
              <div key={r.id} className="rounded-xl border border-line bg-white px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium text-ink-900">
                        Step {r.step_no ?? "?"}
                      </span>
                      {r.citation_label && (
                        <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-[11px] text-ink-700">
                          {r.citation_label}
                        </span>
                      )}
                      <span className="font-mono text-[11px] text-ink-300">
                        Y/A {r.ya ?? "unknown"}
                      </span>
                    </div>
                    {r.note && (
                      <p className="mt-2 text-[13px] leading-[1.55] text-ink-700">
                        {r.note}
                      </p>
                    )}
                    {r.facts_redacted_json && (
                      <pre className="mt-3 overflow-x-auto rounded-lg bg-panel px-3 py-2 font-mono text-[11px] text-ink-500">
                        {JSON.stringify(r.facts_redacted_json)}
                      </pre>
                    )}
                  </div>
                  <span className="flex-none rounded-full bg-panel px-2 py-[3px] font-mono text-[10px] text-ink-500">
                    {r.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
