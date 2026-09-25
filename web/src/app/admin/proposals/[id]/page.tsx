"use client";

/**
 * Document viewer, diff, and impact preview (spec section 5.1 B, C, D).
 *
 * Left: the source document with the extracted sentence. Right: the values as
 * an editable form. The reviewer compares, corrects and signs; never retypes.
 * What gets signed is what is saved, so unsaved edits block signing.
 */

import { ArrowLeft, Check, ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AdminBody, AdminFrame, refreshAdminSummary } from "@/components/admin/AdminShell";
import {
  Confirm, ErrorNote, Panel, Pill, PriorityPill, Stat, StatusPill, day, errorText,
} from "@/components/admin/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  admin, type ImpactReport, type Me, type ProposalRow, type PublishedVersion, type Signatures,
} from "@/lib/admin";

type Proposal = ProposalRow & { raw_text?: string | null };

const CLOSED = new Set(["approved", "published", "rejected"]);

export default function ProposalPage() {
  return <AdminFrame>{(me) => <Review me={me} />}</AdminFrame>;
}

function Review({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [published, setPublished] = useState<PublishedVersion | null>(null);
  const [valueBearing, setValueBearing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ruleKey, setRuleKey] = useState("");
  const [valueText, setValueText] = useState("{}");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");

  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await admin.proposal(id);
      setProposal(data.proposal);
      setPublished(data.published);
      setValueBearing(data.is_value_bearing);
      setRuleKey(data.proposal.rule_key ?? "");
      setValueText(JSON.stringify(data.proposal.value_json ?? {}, null, 2));
      setEffectiveFrom(data.proposal.effective_from ?? "");
      setEffectiveTo(data.proposal.effective_to ?? "");
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e, "Could not load the proposal"));
    }
  }, [id]);

  useEffect(() => {
    // load() only sets state once its request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loadError && !proposal) {
    return (
      <AdminBody>
        <BackLink />
        <div className="mt-4"><ErrorNote>{loadError}</ErrorNote></div>
      </AdminBody>
    );
  }
  if (!proposal) {
    return (
      <AdminBody>
        <BackLink />
        <Skeleton className="mt-4 h-8 w-2/3" />
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </AdminBody>
    );
  }

  const value = parseJson(valueText);
  const dirty =
    ruleKey !== (proposal.rule_key ?? "") ||
    effectiveFrom !== (proposal.effective_from ?? "") ||
    effectiveTo !== (proposal.effective_to ?? "") ||
    JSON.stringify(value) !== JSON.stringify(proposal.value_json ?? {});
  const closed = CLOSED.has(proposal.status);
  const signed: Signatures = proposal.corrected_json ?? {};
  const signedByMe = signed.approved_by === me.email;

  // Why signing is not possible right now, or null when it is.
  const cannotSign = closed
    ? `This proposal is ${proposal.status}.`
    : dirty
      ? "Save your changes first. A signature covers what is saved."
      : !proposal.rule_key
        ? "Fill in the rule key and value, or re-extract."
        : valueBearing && !proposal.effective_from
          ? "Set the date this takes effect from."
          : valueBearing && signedByMe
            ? "You gave the first signature. A different approver must give the second."
            : valueBearing && signed.approved_by && !me.can_approve
              ? `The second signature needs the approver role. Your role is ${me.role}.`
              : null;

  const save = async () => {
    if (!value) return;
    setBusy("save");
    try {
      const res = await admin.editProposal(id, {
        rule_key: ruleKey.trim() || null,
        value_json: value,
        effective_from: effectiveFrom || null,
        effective_to: effectiveTo || null,
      });
      if (res.signatures_cleared) {
        toast.warning("Saved. The signature on this proposal was cleared", {
          description: "What was signed has changed, so it needs signing again.",
        });
      } else {
        toast.success(
          res.corrections_recorded === 0
            ? "Nothing changed"
            : `Saved, ${res.corrections_recorded} correction${res.corrections_recorded === 1 ? "" : "s"} recorded`,
        );
      }
      setImpact(null);
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Save failed"));
    } finally {
      setBusy(null);
    }
  };

  const discard = () => {
    setRuleKey(proposal.rule_key ?? "");
    setValueText(JSON.stringify(proposal.value_json ?? {}, null, 2));
    setEffectiveFrom(proposal.effective_from ?? "");
    setEffectiveTo(proposal.effective_to ?? "");
  };

  const runImpact = async () => {
    setBusy("impact");
    try {
      setImpact((await admin.impact(id)).impact);
    } catch (e) {
      toast.error(errorText(e, "Impact preview failed"));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    setBusy("approve");
    try {
      const res = await admin.approve(id);
      if (res.awaiting_second) {
        toast.success("First signature recorded", { description: "A different approver must countersign." });
      } else {
        toast.success("Approved", { description: "It goes live with the next published snapshot." });
      }
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Could not sign"));
    } finally {
      setBusy(null);
    }
  };

  const reextract = async () => {
    setBusy("extract");
    try {
      const r = await admin.reextract(id);
      if (r.error) toast.error(`The extractor failed: ${r.error}`);
      else if (r.skipped_reason) toast.info(`The extractor skipped this: ${r.skipped_reason}`);
      else toast.success(`Extracted: ${r.proposals_updated} updated, ${r.proposals_created} added`);
      await load();
      refreshAdminSummary();
    } catch (e) {
      toast.error(errorText(e, "Re-extraction failed"));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      await admin.reject(id, reason.trim());
      toast.success("Rejected", { description: "Kept with your reason as extractor training data." });
      refreshAdminSummary();
      router.push("/admin");
    } catch (e) {
      toast.error(errorText(e, "Reject failed"));
      setBusy(null);
    }
  };

  const isRevision = (proposal.revision_no ?? 1) > 1;
  const sourceUrl = proposal.document_url && !proposal.document_url.startsWith("upload://") ? proposal.document_url : null;

  return (
    <AdminBody>
      <BackLink />

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-[1.2] tracking-[-0.02em] text-ink-900">
            {proposal.document_title ?? "Untitled document"}
          </h1>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <StatusPill status={proposal.status} />
            <PriorityPill priority={proposal.priority} />
            {isRevision && <Pill tone="neutral">Revision {proposal.revision_no}</Pill>}
            {valueBearing && <Pill tone="amber">Needs two signatures</Pill>}
          </div>
        </div>
        {sourceUrl && (
          <Button nativeButton={false} variant="outline" render={<a href={sourceUrl} target="_blank" rel="noopener noreferrer" />}>
            <ExternalLink />
            Open source
          </Button>
        )}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Source document">
          {proposal.raw_text ? (
            <HighlightedText text={proposal.raw_text} quote={proposal.rule_key ? proposal.quoted_text : null} />
          ) : (
            <p className="rounded-lg bg-panel px-4 py-8 text-center text-[14px] text-ink-400">
              No text could be taken from this document. Work from the source link.
            </p>
          )}
          {proposal.quoted_text && (
            <div className="mt-3 rounded-lg bg-[#fff8e1] px-4 py-3">
              <div className="text-[12.5px] font-medium text-[#7e5d1b]">
                {proposal.rule_key ? "Quoted by the extractor" : "Note"}
              </div>
              <p className={`mt-1 text-[14px] leading-[1.6] text-ink-700 ${proposal.rule_key ? "statute italic" : ""}`}>
                {proposal.rule_key ? <>&ldquo;{proposal.quoted_text}&rdquo;</> : proposal.quoted_text}
              </p>
              {proposal.rule_key && (
                <p className="mt-2 text-[12.5px] text-ink-400">
                  Compare this sentence with the value. If they disagree, correct the value, not the quote.
                </p>
              )}
            </div>
          )}
        </Panel>

        <Panel
          title="Extracted rule"
          actions={
            <>
              {proposal.confidence != null && (
                <Pill tone={proposal.confidence >= 0.85 ? "good" : proposal.confidence >= 0.6 ? "amber" : "warn"} title="Extractor confidence">
                  {Math.round(proposal.confidence * 100)}% confident
                </Pill>
              )}
              <Button variant="ghost" size="sm" onClick={reextract} disabled={busy !== null || closed} title="Run the extractor again on this document">
                <RefreshCw className={busy === "extract" ? "animate-spin" : ""} />
                {proposal.rule_key ? "Re-extract" : "Extract now"}
              </Button>
            </>
          }
        >
          {proposal.rationale && (
            <div className="rounded-lg bg-brand-050 px-4 py-3">
              <div className="text-[12.5px] font-medium text-brand-700">Why the extractor chose this</div>
              <p className="mt-1 text-[14px] leading-[1.55] text-ink-700">{proposal.rationale}</p>
            </div>
          )}
          {!proposal.rule_key && !proposal.rationale && (
            <p className="rounded-lg bg-panel px-4 py-3 text-[14px] leading-[1.55] text-ink-500">
              Not extracted yet. The corpus agent picks it up on its next cycle, or press extract now.
            </p>
          )}

          <fieldset disabled={closed || busy !== null} className="mt-4 flex flex-col gap-4">
            <Field label="Rule key">
              <Input value={ruleKey} onChange={(e) => setRuleKey(e.target.value)} placeholder="relief.personal" className="h-9 font-mono text-[13px]" />
            </Field>
            <Field label="Value" hint={value ? undefined : "Not valid JSON"}>
              <Textarea
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                rows={7}
                spellCheck={false}
                aria-invalid={!value}
                className="font-mono text-[12.5px] leading-[1.55]"
              />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="In force from">
                <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="h-9" />
              </Field>
              <Field label="In force until" hint="Leave blank if open ended">
                <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} className="h-9" />
              </Field>
            </div>
            {!closed && (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={save} disabled={!dirty || !value || busy !== null}>
                  {busy === "save" ? "Saving..." : "Save changes"}
                </Button>
                {dirty && (
                  <Button variant="ghost" onClick={discard} disabled={busy !== null}>
                    Discard
                  </Button>
                )}
                {dirty && <span className="text-[13px] text-[#7e5d1b]">Unsaved changes</span>}
              </div>
            )}
          </fieldset>
        </Panel>
      </div>

      <Panel title="Compared with what is published" className="mt-4">
        {published ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DiffSide
              title={`Published, revision ${published.revision_no}`}
              citation={published.citation_label}
              value={published.value_json}
              from={published.effective_from}
              to={published.effective_to}
            />
            <DiffSide title="Proposed" citation={dirty ? "unsaved" : null} value={value} from={effectiveFrom || null} to={effectiveTo || null} proposed />
          </div>
        ) : (
          <p className="text-[14px] text-ink-400">Nothing is published for this rule key yet, so this would create it.</p>
        )}
      </Panel>

      <Panel
        title="Impact on the golden set"
        description="Runs every taxpayer scenario against the saved proposal. You are approving a consequence, not a field."
        className="mt-4"
        actions={
          <Button variant="outline" onClick={runImpact} disabled={busy !== null || !proposal.rule_key || dirty} title={dirty ? "Save first" : undefined}>
            {busy === "impact" ? "Running..." : impact ? "Run again" : "Run impact preview"}
          </Button>
        }
      >
        {dirty && !impact && <p className="text-[14px] text-ink-400">Save your changes to preview their impact.</p>}
        {impact && <ImpactView report={impact} />}
      </Panel>

      <section className="mt-4 rounded-xl border border-line bg-white p-5">
        <h2 className="text-[15px] font-semibold text-ink-900">Decision</h2>
        <SignatureTrail signed={signed} valueBearing={valueBearing} status={proposal.status} />
        {!closed && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button onClick={approve} disabled={busy !== null || cannotSign !== null} className="h-9 bg-good-600 px-4 hover:bg-good-700">
              <Check />
              {busy === "approve" ? "Signing..." : valueBearing && signed.approved_by ? "Countersign" : "Approve"}
            </Button>
            <Button variant="destructive" onClick={() => setRejecting(true)} disabled={busy !== null} className="h-9 px-4">
              Reject
            </Button>
            {cannotSign && <span className="text-[13.5px] leading-[1.5] text-ink-400">{cannotSign}</span>}
          </div>
        )}
      </section>

      <Confirm
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this proposal"
        description="Rejections are kept with the reason, as training data for the extractor and evidence for the audit."
        confirmLabel="Reject"
        destructive
        busy={busy === "reject"}
        disabled={!reason.trim()}
        onConfirm={reject}
      >
        <Textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What is wrong with it?"
          rows={3}
          className="text-[14px]"
        />
      </Confirm>
    </AdminBody>
  );
}

/* ---------- pieces ---------- */

function BackLink() {
  return (
    <Link href="/admin" className="inline-flex items-center gap-1.5 text-[13.5px] text-ink-400 hover:text-ink-900">
      <ArrowLeft className="size-4" />
      Review inbox
    </Link>
  );
}

function SignatureTrail({ signed, valueBearing, status }: { signed: Signatures; valueBearing: boolean; status: string }) {
  const steps = valueBearing
    ? [
        { label: "First signature", who: signed.approved_by, hint: "Any reviewer" },
        { label: "Second signature", who: signed.second_approved_by, hint: "A different approver" },
      ]
    : [{ label: "Signature", who: signed.approved_by, hint: "Any reviewer" }];
  return (
    <div className="mt-3">
      <ol className="grid gap-2 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.label} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${s.who ? "bg-good-100" : "bg-panel"}`}>
            <span className={`flex size-6 flex-none items-center justify-center rounded-full ${s.who ? "bg-good-600 text-white" : "border border-line-strong bg-white"}`}>
              {s.who && <Check className="size-3.5" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-ink-400">{s.label}</span>
              <span className="block truncate text-[14px] font-medium text-ink-900">{s.who ?? s.hint}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[13.5px] leading-[1.55] text-ink-400">
        {status === "published"
          ? "Published. It is part of a live snapshot."
          : status === "approved"
            ? "Approved. It goes live when someone publishes a snapshot."
            : status === "rejected"
              ? "Rejected."
              : valueBearing
                ? "This changes a computed figure, so two different people must sign before it can be published."
                : "One signature is enough for this kind of change."}
      </p>
    </div>
  );
}

/** The source text with the quoted sentence marked. Scrolls its own box to
 *  the mark, never the page (spec section 5.1 B). */
function HighlightedText({ text, quote }: { text: string; quote: string | null }) {
  const boxRef = useRef<HTMLPreElement>(null);
  const markRef = useRef<HTMLElement>(null);

  const needle = quote ? quote.trim().slice(0, 60).replace(/\s+/g, " ") : "";
  const hay = quote ? text.replace(/\s+/g, " ") : text;
  const at = needle ? hay.indexOf(needle) : -1;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const mark = markRef.current;
    if (box && mark) box.scrollTop = Math.max(0, mark.offsetTop - box.offsetTop - box.clientHeight / 3);
  }, [at, text]);

  const pre = "relative max-h-[440px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-panel p-4 font-sans text-[13.5px] leading-[1.65] text-ink-700";
  if (at < 0) {
    return (
      <>
        <pre ref={boxRef} className={pre}>{text}</pre>
        {quote && <p className="mt-2 text-[12.5px] text-warn-600">The quoted sentence is not in the text word for word. Check it against the source.</p>}
      </>
    );
  }
  const end = Math.min(hay.length, at + Math.max(needle.length, quote!.trim().length));
  return (
    <pre ref={boxRef} className={pre}>
      {hay.slice(0, at)}
      <mark ref={markRef} className="rounded-sm bg-[#ffe7a3] px-0.5 text-ink-900">{hay.slice(at, end)}</mark>
      {hay.slice(end)}
    </pre>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between text-[13px] font-medium text-ink-500">
        {label}
        {hint && <span className={`font-normal ${hint === "Not valid JSON" ? "text-warn-600" : "text-ink-300"}`}>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function DiffSide({
  title, citation, value, from, to, proposed = false,
}: {
  title: string;
  citation: string | null;
  value: Record<string, unknown> | null;
  from: string | null;
  to: string | null;
  proposed?: boolean;
}) {
  return (
    <div className={`rounded-lg p-4 ${proposed ? "bg-brand-050 ring-1 ring-brand-600/30" : "bg-panel"}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-semibold text-ink-900">{title}</span>
        {citation && <span className="truncate text-[12.5px] text-ink-400">{citation}</span>}
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-white/80 p-3 font-mono text-[12px] leading-[1.5] text-ink-700">
        {value ? JSON.stringify(value, null, 2) : "Not valid JSON"}
      </pre>
      <div className="tnum mt-3 text-[13px] text-ink-500">
        {from ? day(from) : "No start date"} to {to ? day(to) : "open ended"}
      </div>
    </div>
  );
}

function ImpactView({ report }: { report: ImpactReport }) {
  const changed = report.cases.filter((c) => c.changed || c.obligation_flip);
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Scenarios changed" value={`${report.changed} of ${report.total}`} />
        <Stat label="Filing obligation flips" value={report.obligation_flips} tone={report.obligation_flips > 0 ? "warn" : undefined} />
        <Stat label="Median change" value={fmtDelta(report.median_delta)} />
        <Stat
          label="Range"
          value={report.min_delta && report.max_delta ? `${fmtDelta(report.min_delta)} to ${fmtDelta(report.max_delta)}` : "No change"}
        />
      </div>

      {(report.notes ?? []).map((n) => (
        <p key={n} className="mt-3 rounded-lg bg-panel px-4 py-3 text-[13.5px] leading-[1.55] text-ink-500">{n}</p>
      ))}

      {report.obligation_flips > 0 && (
        <div className="mt-3">
          <ErrorNote>
            <strong className="font-semibold">
              {report.obligation_flips} taxpayer{report.obligation_flips === 1 ? "" : "s"} would change filing obligation.
            </strong>{" "}
            Moving someone between must file and need not file is the biggest consequence a rule can have.
          </ErrorNote>
        </div>
      )}

      {report.errors.length > 0 && (
        <div className="mt-3">
          <ErrorNote>{report.errors.slice(0, 3).map((e) => <div key={e}>{e}</div>)}</ErrorNote>
        </div>
      )}

      {changed.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-left">
            <thead className="bg-panel text-[12.5px] text-ink-400">
              <tr>
                <th className="px-4 py-2 font-medium">Scenario</th>
                <th className="px-4 py-2 font-medium">Year</th>
                <th className="px-4 py-2 text-right font-medium">Now</th>
                <th className="px-4 py-2 text-right font-medium">Proposed</th>
                <th className="px-4 py-2 text-right font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {changed.slice(0, 14).map((c) => (
                <tr key={`${c.scenario}-${c.ya}`} className={`border-t border-line-faint text-[13.5px] ${c.obligation_flip ? "bg-warn-100/60" : ""}`}>
                  <td className="px-4 py-2.5 text-ink-900">
                    {c.scenario}
                    {c.obligation_flip && (
                      <span className="ml-2"><Pill tone="warn">{c.new_must_file ? "Now must file" : "Need not file"}</Pill></span>
                    )}
                  </td>
                  <td className="tnum px-4 py-2.5 text-ink-400">{c.ya}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-500">{fmtMoney(c.old_balance)}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-900">{fmtMoney(c.new_balance)}</td>
                  <td className={`tnum px-4 py-2.5 text-right font-medium ${Number(c.delta) > 0 ? "text-warn-600" : "text-good-600"}`}>
                    {fmtDelta(c.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.changed === 0 && report.obligation_flips === 0 && report.errors.length === 0 && (
        <p className="mt-4 text-[14px] text-ink-400">
          No scenario changes. This usually means the proposal matches what is already published.
        </p>
      )}
    </div>
  );
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function fmtMoney(v: string | null): string {
  if (v == null) return "-";
  return Number(v).toLocaleString("en-GB", { maximumFractionDigits: 0 });
}

function fmtDelta(v: string | null): string {
  if (v == null) return "No change";
  const n = Number(v);
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
}
