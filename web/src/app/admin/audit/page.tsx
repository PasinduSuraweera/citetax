"use client";

/** Audit log (spec section 5.1 H). Append only, never editable. */

import { useEffect, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import { admin, type AuditEvent, type Me } from "@/lib/admin";

export default function AuditPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const who = await admin.me();
        setMe(who);
        if (who.is_reviewer) setEvents((await admin.audit(200)).events);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the audit log");
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
          Audit log
        </h1>
        <p className="mt-2 max-w-[660px] text-[14.5px] leading-[1.6] text-ink-500">
          Who, what, when, before and after. Append only, never editable, never
          deletable. This is what a paying practice is actually buying.
        </p>

        {error && (
          <div className="mt-5 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {events.length === 0 ? (
          <p className="mt-6 text-[13.5px] text-ink-400">
            No events recorded yet.
          </p>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-line bg-white">
            <div className="flex items-center border-b border-line px-5 py-3 font-mono text-[10px] tracking-[0.14em] text-ink-300">
              <span className="w-[170px] flex-none">WHEN</span>
              <span className="w-[200px] flex-none">WHO</span>
              <span className="w-[200px] flex-none">ACTION</span>
              <span className="flex-1">DETAIL</span>
            </div>
            {events.map((e) => (
              <div
                key={e.id}
                className="flex items-start border-b border-line-faint px-5 py-[11px] last:border-b-0"
              >
                <span className="w-[170px] flex-none font-mono text-[11.5px] text-ink-500">
                  {new Date(e.at).toLocaleString("en-GB", {
                    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                  })}
                </span>
                <span className="w-[200px] flex-none truncate text-[12.5px] text-ink-700">
                  {e.actor ?? "system"}
                </span>
                <span className="w-[200px] flex-none">
                  <span className="rounded-[5px] bg-[#F2F5FC] px-[7px] py-[3px] font-mono text-[11px] text-ink-700">
                    {e.action}
                  </span>
                </span>
                <span className="min-w-0 flex-1 font-mono text-[11px] leading-[1.5] text-ink-400">
                  {summarise(e)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}

function summarise(e: AuditEvent): string {
  const after = e.after_json as Record<string, unknown> | null;
  if (!after) return e.target_id?.slice(0, 8) ?? "";
  const parts = Object.entries(after)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : v}`);
  return parts.join("  ");
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
