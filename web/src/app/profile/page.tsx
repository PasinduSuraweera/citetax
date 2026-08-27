"use client";

import { useEffect, useState } from "react";
import { Shell, type YA } from "@/components/Shell";
import { api, type Snapshot } from "@/lib/api";

const NEVER_STORED = [
  { what: "Your NIC or TIN", how: "Stripped by pattern match before anything is sent" },
  { what: "Your name", how: "Replaced with a placeholder by the intake node" },
  { what: "Your employer", how: "Tagged and masked, it does not affect a computation" },
  { what: "Payslip text", how: "Only the extracted figures continue past intake" },
];

export default function ProfilePage() {
  const [ya, setYa] = useState<YA>("2026/2027");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    api.snapshot().then(setSnapshot).catch(() => setSnapshot(null));
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <Shell ya={ya} onYaChange={setYa} snapshot={snapshot} />
      <main className="flex-1 overflow-y-auto px-11 py-9">
        <div className="max-w-[900px]">
          <h1 className="text-[32px] font-semibold leading-[1.15] tracking-[-0.03em] text-ink-900">
            Privacy
          </h1>
          <p className="mt-[10px] max-w-[640px] text-[15px] leading-[1.6] text-ink-500">
            Identifiers are stripped by a deterministic redaction layer with a
            measured leak rate. The hosted model is only ever sent structured
            facts and law text, never a payslip and never an identity.
          </p>

          <div className="mt-7 rounded-xl bg-ink-900 px-6 py-6">
            <div className="font-mono text-[10px] tracking-[0.16em] text-white/40">
              WHAT WE NEVER SEND
            </div>
            <div className="mt-4 flex flex-col gap-3">
              {NEVER_STORED.map((n) => (
                <div key={n.what} className="flex items-start gap-[10px]">
                  <span className="mt-[2px] font-mono text-[11px] font-semibold text-[#F5A9A2]">
                    ✕
                  </span>
                  <div>
                    <div className="text-[13.5px] font-semibold text-white">
                      {n.what}
                    </div>
                    <div className="mt-[2px] text-[12px] leading-[1.45] text-white/45">
                      {n.how}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-5 border-t border-white/10 pt-[14px] text-[12px] leading-[1.55] text-white/50">
              Redaction runs on the server before any hosted call, not in the
              browser. The figures a computation needs are deliberately
              preserved, which is the harder half of the job.
            </p>
          </div>

          <div className="mt-4 rounded-xl border border-line bg-white px-6 py-5">
            <div className="eyebrow">SCOPE</div>
            <p className="mt-[11px] text-[13.5px] leading-[1.6] text-ink-700">
              Personal income tax, years of assessment 2025/2026 and 2026/2027.
              Everything else is refused with a reason, not guessed.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
