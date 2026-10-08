"use client";

/**
 * Payslip upload flow: extract, confirm, compute.
 *
 * Renders inline in the main column, the same way a regular question's
 * answer replaces the composer, not as an overlay. Nothing is computed or
 * saved until the user confirms the extracted figures. Reading the file sends
 * it whole to Google's Gemini model, identifiers included, so nothing is sent
 * until the user agrees; they can type the three figures instead (#51).
 */

import Link from "next/link";
import { FileText, Loader2, Printer, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  money,
  type AnswerResponse,
  type ComputeResponse,
  type PayslipExtractResponse,
  type StreamStep,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AnswerView } from "./AnswerView";
import { Composer } from "./Composer";
import { ComputationTable } from "./ComputationTable";
import { LiveTrace } from "./LiveTrace";

interface Props {
  file: File;
  ya: string;
  onClose: () => void;
}

type Phase = "consent" | "extracting" | "confirm" | "computing" | "result" | "error";

export function PayslipConfirm({ file, ya, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("consent");
  // Figures typed by the user rather than read from the file.
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 402: reading a payslip is part of the paid plans.
  const [needsPlan, setNeedsPlan] = useState(false);
  const [extraction, setExtraction] = useState<PayslipExtractResponse | null>(null);
  const [employmentIncome, setEmploymentIncome] = useState("");
  const [epfEmployee, setEpfEmployee] = useState("");
  const [apitWithheld, setApitWithheld] = useState("");
  const [result, setResult] = useState<ComputeResponse | null>(null);

  // Follow-up question, answered in place; this screen never navigates away.
  const [followUp, setFollowUp] = useState("");
  const [followUpAsked, setFollowUpAsked] = useState<string | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState<AnswerResponse | null>(null);
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const [followUpTrace, setFollowUpTrace] = useState<StreamStep[]>([]);
  const [followUpPlan, setFollowUpPlan] = useState<string[] | null>(null);
  const followUpRef = useRef<HTMLTextAreaElement>(null);

  const contextPrefix = () =>
    `For ${ya}, my annual employment income is LKR ${employmentIncome || "0"}, ` +
    `EPF (employee share) is LKR ${epfEmployee || "0"}, and APIT already withheld ` +
    `is LKR ${apitWithheld || "0"}. `;

  const askFollowUp = async (question: string) => {
    if (!question.trim() || followUpBusy) return;
    setFollowUpBusy(true);
    setFollowUpError(null);
    setFollowUpAsked(question);
    setFollowUpAnswer(null);
    setFollowUpTrace([]);
    setFollowUpPlan(null);
    try {
      setFollowUpAnswer(
        await api.askStream(
          contextPrefix() + question,
          ya,
          (step) => setFollowUpTrace((t) => [...t, step]),
          { onPlan: setFollowUpPlan },
        ),
      );
    } catch (e) {
      setFollowUpError(e instanceof ApiError ? e.message : "Something went wrong reaching the API.");
    } finally {
      setFollowUpBusy(false);
    }
  };

  useEffect(() => {
    if (phase !== "extracting") return;
    let cancelled = false;
    api
      .payslipExtract(file, ya)
      .then((r) => {
        if (cancelled) return;
        setExtraction(r);
        setEmploymentIncome(r.fields.employment_income ?? "");
        setEpfEmployee(r.fields.epf_employee ?? "");
        setApitWithheld(r.fields.apit_withheld ?? "");
        setPhase("confirm");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "Could not read that document.");
        setNeedsPlan(e instanceof ApiError && e.status === 402);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // Runs once, when the user agrees to send the file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase === "extracting"]);

  const confirm = async () => {
    setPhase("computing");
    setError(null);
    try {
      const r = await api.compute({
        ya,
        source: "payslip",
        employment_income: employmentIncome || "0",
        epf_employee: epfEmployee || "0",
        apit_withheld: apitWithheld || "0",
      });
      setResult(r);
      setPhase("result");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
      setPhase("error");
    }
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-brand-050 text-brand-600">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-medium text-ink-900">{file.name}</p>
          <p className="text-[12.5px] text-ink-400">Payslip, year of assessment {ya}</p>
        </div>
        {phase !== "result" && (
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Cancel payslip">
            <X />
          </Button>
        )}
      </div>

      {phase === "consent" && (
        <div className="mt-5 rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
          <h2 className="text-[17px] font-semibold text-ink-900">Before it is read</h2>
          <p className="mt-2 max-w-[60ch] text-[14.5px] leading-[1.6] text-ink-700">
            To read the figures, Citetax sends this file to Google&apos;s Gemini model.
            Everything on it goes with it, including your name, NIC and employer.
          </p>
          <p className="mt-2 max-w-[60ch] text-[14px] leading-[1.6] text-ink-500">
            Citetax does not store the file, and only the three figures you confirm
            are kept. If you would rather not send it, type the figures yourself.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button onClick={() => setPhase("extracting")} className="h-10 px-4">
              Send it to Gemini and read it
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setManual(true);
                setPhase("confirm");
              }}
              className="h-10"
            >
              Type the figures instead
            </Button>
          </div>
        </div>
      )}

      {phase === "extracting" && (
        <div className="mt-5 px-1" aria-live="polite">
          <p className="flex items-center gap-2 text-[14px] text-ink-500">
            <Loader2 className="size-4 animate-spin text-brand-600" />
            Reading your payslip
          </p>
          <div className="mt-4 flex max-w-[420px] flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      )}

      {phase === "error" && (
        <div role="alert" className="mt-5 rounded-lg bg-warn-100 px-5 py-4">
          <p className="text-[15px] font-semibold text-warn-700">This payslip could not be read</p>
          <p className="mt-1 text-[14px] leading-[1.55] text-warn-700">
            {error}
            {needsPlan && (
              <>
                {" "}
                <Link href="/pricing" className="font-medium underline underline-offset-4">See the plans</Link>
              </>
            )}
          </p>
          <Button variant="outline" onClick={onClose} className="mt-4 bg-white">
            Type the figures in a question instead
          </Button>
        </div>
      )}

      {(phase === "confirm" || phase === "computing") && (extraction || manual) && (
        <div className="mt-5 rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
          <h2 className="text-[17px] font-semibold text-ink-900">
            {manual ? "Enter the figures" : "Check the figures"}
          </h2>
          <p className="mt-1 text-[14px] leading-[1.6] text-ink-500">
            {manual
              ? "Annual amounts from your payslip, for the whole year of assessment."
              : "These were read from your payslip. Correct anything that is wrong before your tax is worked out."}
          </p>

          <div className="mt-5 flex max-w-[420px] flex-col gap-4">
            <Field id="pay-income" label="Employment income for the year" value={employmentIncome} onChange={setEmploymentIncome} />
            <Field id="pay-epf" label="EPF, your share, for the year" value={epfEmployee} onChange={setEpfEmployee} />
            <Field id="pay-apit" label="APIT already deducted this year" value={apitWithheld} onChange={setApitWithheld} />
          </div>

          {extraction?.pay_period === "monthly" && (
            <p className="mt-3 text-[13px] text-ink-400">
              Your payslip showed monthly figures, so they have been multiplied by 12.
            </p>
          )}
          {extraction && extraction.warnings.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1.5 rounded-lg bg-[#fdf4e0] px-4 py-3 text-[13.5px] text-[#6b4a0b]">
              {extraction.warnings.map((w) => (
                <li key={w} className="flex items-start gap-2">
                  <TriangleAlert className="mt-[3px] size-3.5 flex-none" />
                  {w}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-5 flex items-start gap-2 text-[13px] leading-[1.5] text-ink-500">
            <ShieldCheck className="mt-[2px] size-4 flex-none text-good-600" />
            {manual
              ? "Your payslip was not sent anywhere. Only these three figures are used."
              : "Only these three figures were kept. The file was sent to Gemini to be read and was never stored by Citetax."}
          </p>

          <div className="mt-6 flex items-center gap-2">
            <Button onClick={confirm} disabled={phase === "computing"} className="h-10 px-4">
              {phase === "computing" && <Loader2 className="animate-spin" />}
              {phase === "computing" ? "Working it out" : "Work out my tax"}
            </Button>
            <Button variant="ghost" onClick={onClose} className="h-10">
              Cancel
            </Button>
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <div className="mt-5">
          <div className="print-area">
            <div className="text-[13px] font-medium text-ink-400">
              {result.is_refund ? "Refund due" : "Balance payable"}, year of assessment {result.ya}
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-ink-900">
              <span className="text-[22px] font-medium text-ink-300">LKR</span>
              <span className="tnum text-[40px] font-semibold tracking-[-0.03em]">
                {money(result.balance_payable.replace(/^-/, ""))}
              </span>
            </div>
            <div className="mt-4">
              <ComputationTable steps={result.steps} balance={result.balance_payable} isRefund={result.is_refund} />
            </div>
          </div>

          <div className="no-print mt-4 flex items-center gap-2">
            <Button variant="outline" onClick={() => window.print()}>
              <Printer />
              Download PDF
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Done
            </Button>
          </div>

          <div className="no-print mt-10">
            <h2 className="text-[15px] font-semibold text-ink-900">Ask about this result</h2>
            <p className="mt-1 text-[13.5px] text-ink-500">
              The figures above are sent with your question, not the payslip.
            </p>
            <div className="mt-3">
              <Composer
                value={followUp}
                onChange={setFollowUp}
                onSubmit={(q) => {
                  void askFollowUp(q);
                  setFollowUp("");
                }}
                ya={ya}
                busy={followUpBusy}
                inputRef={followUpRef}
                placeholder="For example: how much more would I owe with a raise of 50,000 a month?"
              />
            </div>

            {followUpBusy && followUpAsked && <LiveTrace steps={followUpTrace} plan={followUpPlan} />}

            {followUpError && (
              <div role="alert" className="mt-4 rounded-lg bg-warn-100 px-5 py-4 text-[14px] leading-[1.55] text-warn-700">
                {followUpError}
              </div>
            )}

            {followUpAnswer && followUpAsked && !followUpBusy && (
              <div className="mt-8">
                <AnswerView
                  question={followUpAsked}
                  answer={followUpAnswer}
                  onClarifyAnswer={(t) => askFollowUp(`${followUpAsked} ${t}`)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-[13.5px] font-medium text-ink-700">{label}</Label>
      <div className="relative mt-1.5">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-ink-400">LKR</span>
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="tnum h-10 pl-12 text-[15px]"
        />
      </div>
    </div>
  );
}
