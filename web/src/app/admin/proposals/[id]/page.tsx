"use client";

/**
 * Document viewer, diff, and impact preview (spec section 5.1 B, C, D).
 *
 * Left: the source document with the extracted span. Right: the values as an
 * editable form. The reviewer compares, corrects and signs; never retypes.
 */

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdminShell, NoAccess } from "@/components/admin/AdminShell";
import {
  admin,
  type ImpactReport,
  type Me,
  type ProposalRow,
  type PublishedVersion,
} from "@/lib/admin";

export default function ProposalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [proposal, setProposal] = useState<ProposalRow & { raw_text?: string | null } | null>(null);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const [valueBearing, setValueBearing] = useState(false);

  const [ruleKey, setRuleKey] = useState("");
  const [valueText, setValueText] = useState("{}");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");

  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await admin.me();
      setMe(who);
      if (!who.is_reviewer) return;
      const data = await admin.proposal(id);
      setProposal(data.proposal);
      setPublished(data.published);
      setValueBearing(data.is_value_bearing);
      setRuleKey(data.proposal.rule_key ?? "");
      setValueText(JSON.stringify(data.proposal.value_json ?? {}, null, 2));
      setEffectiveFrom(data.proposal.effective_from ?? "");
      setEffectiveTo(data.proposal.effective_to ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the proposal");
    } finally {
      setReady(true);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!ready) return <Loading />;
  if (!me?.is_reviewer) return <NoAccess me={me} />;
  if (!proposal) {
    return (
      <AdminShell me={me}>
        <div className="px-9 py-8 text-[14px] text-warn-500">
          {error ?? "Proposal not found"}
        </div>
      </AdminShell>
    );
  }

  const parseValue = (): Record<string, unknown> | null => {
    try {
      return JSON.parse(valueText);
    } catch {
      setError("The value is not valid JSON, so it cannot be saved.");
      return null;
    }
  };

  const save = async () => {
    const value = parseValue();
    if (!value) return;
    setBusy("save");
    setError(null);
    try {
      const res = await admin.editProposal(id, {
        rule_key: ruleKey || null,
        value_json: value,
        effective_from: effectiveFrom || null,
        effective_to: effectiveTo || null,
      });
      setMessage(
        `Saved. ${res.corrections_recorded} correction(s) recorded against the extractor.`,
      );
      setImpact(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const runImpact = async () => {
    setBusy("impact");
    setError(null);
    try {
      const res = await admin.impact(id);
      setImpact(res.impact);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Impact preview failed");
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      const res = await admin.approve(id);
      setMessage(
        res.awaiting_second
          ? res.message ?? "First signature recorded."
          : "Approved. It will enter the corpus at the next publish.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  };

  const reextract = async () => {
    setBusy("extract");
    setError(null);
    try {
      const r = await admin.reextract(id);
      if (r.error) setError(`Extractor failed: ${r.error}`);
      else if (r.skipped_reason) setError(`Extractor skipped: ${r.skipped_reason}`);
      else
        setMessage(
          `Extractor re-ran. ${r.proposals_updated} field set updated, ${r.proposals_created} additional proposal(s) created.${r.summary ? ` Document: ${r.summary}` : ""}`,
        );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-extraction failed");
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    const reason = window.prompt(
      "Why is this rejected? Rejections are kept forever with the reason, as extractor training data and audit evidence.",
    );
    if (!reason?.trim()) return;
    setBusy("reject");
    try {
      await admin.reject(id, reason.trim());
      router.push("/admin");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
      setBusy(null);
    }
  };

  const isRevision = (proposal.revision_no ?? 1) > 1;

  return (
    <AdminShell me={me}>
      <div className="px-9 py-8">
        <Link href="/admin" className="font-mono text-[11px] text-brand-600">
          back to inbox
        </Link>

        <div className="mt-3 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="truncate text-[26px] font-semibold tracking-[-0.03em] text-ink-900">
              {proposal.document_title ?? "Untitled document"}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-line-strong bg-white px-[9px] py-[3px] font-mono text-[11px] text-ink-700">
                {proposal.status}
              </span>
              {isRevision && (
                <span className="rounded-full border border-warn-300 bg-warn-100 px-[9px] py-[3px] font-mono text-[11px] font-semibold text-warn-600">
                  revision {proposal.revision_no}, supersedes{" "}
                  {(proposal.revision_no ?? 2) - 1}
                </span>
              )}
              {valueBearing && (
                <span className="rounded-full border border-[#EBD6A8] bg-[#FDF4E0] px-[9px] py-[3px] font-mono text-[11px] font-semibold text-[#7E5D1B]">
                  dual control required
                </span>
              )}
              {proposal.document_url && !proposal.document_url.startsWith("upload://") && (
                <a
                  href={proposal.document_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] text-brand-600 hover:underline"
                >
                  open source
                </a>
              )}
            </div>
          </div>
        </div>

        {message && (
          <div className="mt-4 rounded-xl border border-good-300 bg-good-100 px-5 py-3 text-[13.5px] text-good-500">
            {message}
          </div>
        )}
        {error && (
          <div className="mt-4 rounded-xl border border-warn-300 bg-warn-100 px-5 py-3 text-[13.5px] text-warn-500">
            {error}
          </div>
        )}

        {/* Split pane: source left, editable values right */}
        <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-2">
          <div className="rounded-xl border border-line bg-white p-5">
            <div className="eyebrow">SOURCE DOCUMENT</div>
            {proposal.raw_text ? (
              <HighlightedText text={proposal.raw_text} quote={proposal.rule_key ? proposal.quoted_text : null} />
            ) : (
              <div className="mt-3 rounded-lg border border-dashed border-line-strong bg-panel px-4 py-10 text-center">
                <p className="text-[13px] text-ink-400">
                  No extracted text for this document.
                </p>
                <p className="mx-auto mt-2 max-w-[330px] text-[12px] leading-[1.55] text-ink-300">
                  PDF text extraction is not wired yet, so the reviewer works
                  from the source link. Recording that honestly beats rendering
                  an empty pane that looks broken.
                </p>
              </div>
            )}
            {proposal.quoted_text && (
              <div className="mt-3 rounded-lg border border-[#E8D9A0] bg-[#FFF8E1] px-4 py-3">
                <div className="font-mono text-[10px] tracking-[0.14em] text-[#7E5D1B]">
                  {proposal.rule_key ? "QUOTED FROM THE DOCUMENT" : "NOTE"}
                </div>
                <p className="mt-2 text-[12.5px] leading-[1.6] text-ink-700">
                  {proposal.rule_key ? <>“{proposal.quoted_text}”</> : proposal.quoted_text}
                </p>
                {proposal.rule_key && (
                  <p className="mt-2 text-[11px] text-ink-400">
                    Compare this sentence to the value on the right. If they disagree, correct the field, not the quote.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-line bg-white p-5">
            <div className="flex items-center justify-between">
              <div className="eyebrow">EXTRACTED RULE</div>
              <div className="flex items-center gap-3">
                {proposal.confidence != null && (
                  <span
                    className={`rounded-full px-2 py-[3px] font-mono text-[10px] font-semibold ${
                      proposal.confidence >= 0.85
                        ? "bg-good-100 text-good-600"
                        : proposal.confidence >= 0.6
                          ? "bg-[#FDF4E0] text-[#7E5D1B]"
                          : "bg-warn-100 text-warn-600"
                    }`}
                    title="Extractor confidence"
                  >
                    {Math.round(proposal.confidence * 100)}% confident
                  </span>
                )}
                <button
                  type="button"
                  onClick={reextract}
                  disabled={busy !== null || proposal.status === "approved" || proposal.status === "published"}
                  className="font-mono text-[11px] text-brand-600 hover:underline disabled:opacity-40"
                  title="Run the model extractor again on this document"
                >
                  {busy === "extract" ? "extracting..." : proposal.rule_key ? "re-extract" : "extract now"}
                </button>
              </div>
            </div>

            {proposal.rationale && (
              <div className="mt-3 rounded-lg border border-brand-600/30 bg-brand-050 px-4 py-3">
                <div className="font-mono text-[10px] tracking-[0.14em] text-brand-600">
                  EXTRACTOR RATIONALE
                </div>
                <p className="mt-1 text-[12.5px] leading-[1.55] text-ink-700">{proposal.rationale}</p>
                {proposal.extractor_version && (
                  <div className="mt-2 font-mono text-[10px] text-ink-300">
                    {proposal.extractor_version}
                  </div>
                )}
              </div>
            )}

            {!proposal.rule_key && !proposal.rationale && (
              <div className="mt-3 rounded-lg border border-dashed border-line-strong bg-panel px-4 py-3 text-[12.5px] leading-[1.55] text-ink-400">
                Not extracted yet. The corpus agent picks up blank proposals on its
                next cycle, or press extract now.
              </div>
            )}

            <div className="mt-4 flex flex-col gap-4">
              <Field label="Rule key">
                <input
                  value={ruleKey}
                  onChange={(e) => setRuleKey(e.target.value)}
                  placeholder="relief.personal"
                  className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-brand-600"
                />
              </Field>

              <Field label="Value">
                <textarea
                  value={valueText}
                  onChange={(e) => setValueText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="w-full resize-y rounded-lg border border-line-strong bg-white px-3 py-2 font-mono text-[12.5px] leading-[1.55] outline-none focus:border-brand-600"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="In force from">
                  <input
                    type="date"
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value)}
                    className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-brand-600"
                  />
                </Field>
                <Field label="In force to (blank means open)">
                  <input
                    type="date"
                    value={effectiveTo}
                    onChange={(e) => setEffectiveTo(e.target.value)}
                    className="w-full rounded-lg border border-line-strong bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-brand-600"
                  />
                </Field>
              </div>

              <button
                type="button"
                onClick={save}
                disabled={busy !== null}
                className="self-start rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 hover:border-brand-600 disabled:opacity-40"
              >
                {busy === "save" ? "Saving..." : "Save corrections"}
              </button>
            </div>
          </div>
        </div>

        {/* Diff */}
        <div className="mt-4 rounded-xl border border-line bg-white p-5">
          <div className="eyebrow">DIFF AGAINST THE PUBLISHED VERSION</div>
          {published ? (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <DiffSide
                title={`Published, revision ${published.revision_no}`}
                citation={published.citation_label}
                value={published.value_json}
                from={published.effective_from}
                to={published.effective_to}
                tone="old"
              />
              <DiffSide
                title="Proposed"
                citation="pending approval"
                value={safeParse(valueText)}
                from={effectiveFrom || null}
                to={effectiveTo || null}
                tone="new"
              />
            </div>
          ) : (
            <p className="mt-3 text-[13px] text-ink-400">
              No published version of this rule key yet, so there is nothing to
              diff against. This would create the rule.
            </p>
          )}
        </div>

        {/* Impact */}
        <div className="mt-4 rounded-xl border border-line bg-white p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">IMPACT PREVIEW</div>
              <p className="mt-2 max-w-[560px] text-[13px] leading-[1.55] text-ink-400">
                Runs the golden set of taxpayer scenarios against the proposed
                corpus. You are approving a consequence, not a field.
              </p>
            </div>
            <button
              type="button"
              onClick={runImpact}
              disabled={busy !== null || !ruleKey}
              className="rounded-lg bg-brand-600 px-4 py-2 text-[13px] font-semibold text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {busy === "impact" ? "Running..." : "Run impact preview"}
            </button>
          </div>

          {impact && <ImpactView report={impact} />}
        </div>

        {/* Decision */}
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-5 py-4">
          <button
            type="button"
            onClick={approve}
            disabled={busy !== null}
            className="rounded-lg bg-good-600 px-5 py-[10px] text-[13.5px] font-semibold text-white hover:bg-good-700 disabled:opacity-40"
          >
            {busy === "approve" ? "Signing..." : "Approve"}
          </button>
          <button
            type="button"
            onClick={reject}
            disabled={busy !== null}
            className="rounded-lg border border-warn-300 bg-warn-100 px-5 py-[10px] text-[13.5px] font-semibold text-warn-600 hover:border-warn-600 disabled:opacity-40"
          >
            Reject
          </button>
          <span className="text-[12.5px] leading-[1.5] text-ink-400">
            {valueBearing
              ? "This changes a computed figure, so it needs two distinct approvers before it can be published."
              : "Editorial change. One signature is enough."}
          </span>
        </div>
      </div>
    </AdminShell>
  );
}

/* ---------- pieces ---------- */

/** The source text with the extracted sentence highlighted and scrolled into
 *  view (spec section 5.1 B). */
function HighlightedText({ text, quote }: { text: string; quote: string | null }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "center" });
  }, [quote]);

  if (!quote) {
    return (
      <pre className="mt-3 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel p-4 text-[12.5px] leading-[1.6] text-ink-700">
        {text}
      </pre>
    );
  }
  // Match on a normalised prefix so minor whitespace differences still land.
  const needle = quote.trim().slice(0, 60).replace(/\s+/g, " ");
  const hay = text.replace(/\s+/g, " ");
  const at = hay.indexOf(needle);
  if (at < 0) {
    return (
      <>
        <pre className="mt-3 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel p-4 text-[12.5px] leading-[1.6] text-ink-700">
          {text}
        </pre>
        <p className="mt-2 font-mono text-[10.5px] text-warn-600">
          quoted sentence not found verbatim in the text; check the quote against the source
        </p>
      </>
    );
  }
  const end = Math.min(hay.length, at + Math.max(needle.length, quote.trim().length));
  return (
    <pre className="mt-3 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel p-4 text-[12.5px] leading-[1.6] text-ink-700">
      {hay.slice(0, at)}
      <mark ref={ref} className="rounded-sm bg-[#FFE7A3] px-[2px] text-ink-900">
        {hay.slice(at, end)}
      </mark>
      {hay.slice(end)}
    </pre>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-[6px] block text-[11.5px] font-medium text-ink-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function DiffSide({
  title, citation, value, from, to, tone,
}: {
  title: string;
  citation: string | null;
  value: Record<string, unknown> | null;
  from: string | null;
  to: string | null;
  tone: "old" | "new";
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === "new" ? "border-brand-600 bg-brand-050" : "border-line bg-panel"
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-ink-900">{title}</span>
        <span className="font-mono text-[10.5px] text-ink-300">{citation}</span>
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded bg-white/70 p-3 font-mono text-[11.5px] leading-[1.5] text-ink-700">
        {value ? JSON.stringify(value, null, 2) : "not valid JSON"}
      </pre>
      <div className="mt-3 font-mono text-[10.5px] text-ink-400">
        {from ?? "no start date"} to {to ?? "open ended"}
      </div>
    </div>
  );
}

function ImpactView({ report }: { report: ImpactReport }) {
  const changed = report.cases.filter((c) => c.changed || c.obligation_flip);
  return (
    <div className="mt-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="CASES CHANGED" value={`${report.changed} of ${report.total}`} />
        <Stat
          label="OBLIGATION FLIPS"
          value={String(report.obligation_flips)}
          tone={report.obligation_flips > 0 ? "warn" : undefined}
        />
        <Stat label="MEDIAN DELTA" value={fmtDelta(report.median_delta)} />
        <Stat
          label="RANGE"
          value={
            report.min_delta && report.max_delta
              ? `${fmtDelta(report.min_delta)} to ${fmtDelta(report.max_delta)}`
              : "no change"
          }
        />
      </div>

      {report.obligation_flips > 0 && (
        <div className="mt-4 rounded-lg border border-warn-300 bg-warn-100 px-4 py-3 text-[13px] text-warn-500">
          <strong className="font-semibold text-warn-700">
            {report.obligation_flips} taxpayer{report.obligation_flips === 1 ? "" : "s"}{" "}
            change filing obligation.
          </strong>{" "}
          Moving someone between must file and need not file is the highest
          consequence change a rule can make.
        </div>
      )}

      {report.errors.length > 0 && (
        <div className="mt-4 rounded-lg border border-warn-300 bg-warn-100 px-4 py-3 text-[12.5px] text-warn-500">
          {report.errors.slice(0, 3).map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      {changed.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-lg border border-line">
          <div className="flex items-center bg-panel px-4 py-2 font-mono text-[10px] tracking-[0.14em] text-ink-300">
            <span className="flex-1">SCENARIO</span>
            <span className="w-[90px] flex-none">YEAR</span>
            <span className="w-[110px] flex-none text-right">OLD</span>
            <span className="w-[110px] flex-none text-right">NEW</span>
            <span className="w-[110px] flex-none text-right">DELTA</span>
          </div>
          {changed.slice(0, 14).map((c) => (
            <div
              key={`${c.scenario}-${c.ya}`}
              className={`flex items-center border-t border-line-faint px-4 py-[10px] ${
                c.obligation_flip ? "bg-warn-100" : ""
              }`}
            >
              <span className="flex-1 text-[13px] text-ink-900">
                {c.scenario}
                {c.obligation_flip && (
                  <span className="ml-2 rounded-full bg-warn-600 px-[6px] py-[1px] font-mono text-[9.5px] font-semibold text-white">
                    {c.new_must_file ? "NOW MUST FILE" : "NEED NOT FILE"}
                  </span>
                )}
              </span>
              <span className="w-[90px] flex-none font-mono text-[11.5px] text-ink-400">
                {c.ya}
              </span>
              <span className="tnum w-[110px] flex-none text-right font-mono text-[12.5px] text-ink-500">
                {fmtMoney(c.old_balance)}
              </span>
              <span className="tnum w-[110px] flex-none text-right font-mono text-[12.5px] text-ink-900">
                {fmtMoney(c.new_balance)}
              </span>
              <span
                className={`tnum w-[110px] flex-none text-right font-mono text-[12.5px] font-medium ${
                  Number(c.delta) > 0 ? "text-warn-600" : "text-good-600"
                }`}
              >
                {fmtDelta(c.delta)}
              </span>
            </div>
          ))}
        </div>
      )}

      {report.changed === 0 && report.obligation_flips === 0 && (
        <p className="mt-4 text-[13px] text-ink-400">
          No golden case changes. This proposal has no effect on any computed
          figure, which usually means it matches what is already published.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        tone === "warn" ? "border-warn-300 bg-warn-100" : "border-line bg-panel"
      }`}
    >
      <div className="font-mono text-[10px] tracking-[0.14em] text-ink-300">
        {label}
      </div>
      <div
        className={`tnum mt-1 font-mono text-[17px] font-semibold ${
          tone === "warn" ? "text-warn-600" : "text-ink-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fmtMoney(v: string | null): string {
  if (v == null) return "-";
  return Number(v).toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

function fmtDelta(v: string | null): string {
  if (v == null) return "no change";
  const n = Number(v);
  if (n === 0) return "0";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface">
      <span className="font-mono text-[12px] text-ink-300">Loading...</span>
    </div>
  );
}
