"use client";

/**
 * Payslip upload flow: extract → confirm → compute.
 *
 * Renders inline in the main column, the same way a regular question's
 * answer replaces the composer — not as an overlay. Nothing is computed or
 * saved until the user confirms the extracted figures. The photo/PDF itself
 * never touches this component after the initial upload call — only the
 * numeric response from `/v1/payslip/extract` does.
 */

import { useEffect, useState } from "react";
import { api, ApiError, money, type ComputeResponse, type PayslipExtractResponse } from "@/lib/api";
import { ComputationTable } from "./ComputationTable";

interface Props {
  file: File;
  ya: string;
  onClose: () => void;
  onAskAbout: (draft: string) => void;
}

type Phase = "extracting" | "confirm" | "computing" | "result" | "error";

export function PayslipConfirm({ file, ya, onClose, onAskAbout }: Props) {
  const [phase, setPhase] = useState<Phase>("extracting");
  const [error, setError] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<PayslipExtractResponse | null>(null);
  const [employmentIncome, setEmploymentIncome] = useState("");
  const [epfEmployee, setEpfEmployee] = useState("");
  const [apitWithheld, setApitWithheld] = useState("");
  const [result, setResult] = useState<ComputeResponse | null>(null);

  useEffect(() => {
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
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
    // Only ever runs once per uploaded file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div className="mx-auto w-full max-w-[1000px]">
      <div className="flex items-center gap-[14px] rounded-xl border border-line bg-white px-[18px] py-4">
        <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-ink-900 text-[11px] font-semibold text-white">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 2h6l3 3v9a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
            <path d="M10 2v3h3" />
          </svg>
        </span>
        <p className="flex-1 text-[15px] leading-[1.5] text-ink-900">
          {file.name}
        </p>
      </div>

      {phase === "extracting" && (
        <p className="mt-4 px-1 text-[14px] leading-[1.6] text-ink-500">
          Reading the document…
        </p>
      )}

      {phase === "error" && (
        <div className="mt-4 rounded-xl border border-warn-300 bg-warn-100 px-5 py-4">
          <p className="text-[14px] leading-[1.55] text-warn-500">{error}</p>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
          >
            Enter figures manually instead
          </button>
        </div>
      )}

      {(phase === "confirm" || phase === "computing") && extraction && (
        <div className="mt-4 rounded-xl border border-line bg-white px-5 py-5 sm:px-6">
          <div className="eyebrow">CHECK THE FIGURES</div>
          <p className="mt-2 text-[13.5px] leading-[1.6] text-ink-500">
            Edit anything that doesn&apos;t look right before continuing.
          </p>

          <div className="mt-4 flex flex-col gap-3 max-w-[420px]">
            <Field label="Annual employment income (LKR)" value={employmentIncome} onChange={setEmploymentIncome} />
            <Field label="Annual EPF (employee share, LKR)" value={epfEmployee} onChange={setEpfEmployee} />
            <Field label="Annual APIT withheld (LKR)" value={apitWithheld} onChange={setApitWithheld} />
          </div>

          {extraction.pay_period === "monthly" && (
            <p className="mt-3 text-[12px] text-ink-400">
              Figures shown were read as monthly and multiplied by 12.
            </p>
          )}
          {extraction.warnings.length > 0 && (
            <ul className="mt-3 list-inside list-disc text-[12px] text-warn-500">
              {extraction.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex gap-3 rounded-[9px] bg-brand-050 px-[13px] py-3">
            <span className="mt-[1px] font-mono text-[11px] font-semibold text-brand-600">i</span>
            <span className="text-[12.5px] leading-[1.5] text-ink-700">
              Only these figures were kept — the photo and any text on it
              were discarded and never stored.
            </span>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              disabled={phase === "computing"}
              className="rounded-lg bg-brand-600 px-[18px] py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "computing" ? "Computing…" : "Looks right, continue"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "result" && result && (
        <div className="mt-4">
          <div className="print-area">
            <p className="text-[15px] leading-[1.5] text-ink-900">
              {result.is_refund ? "Refund" : "Balance payable"} for {result.ya}:{" "}
              <span className="font-semibold">LKR {money(result.balance_payable)}</span>
            </p>
            <div className="mt-3">
              <ComputationTable
                steps={result.steps}
                balance={result.balance_payable}
                isRefund={result.is_refund}
              />
            </div>
          </div>

          <div className="no-print mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={() =>
                onAskAbout(
                  `For ${ya}, my annual employment income is LKR ${employmentIncome || "0"}, ` +
                    `EPF (employee share) is LKR ${epfEmployee || "0"}, and APIT already withheld ` +
                    `is LKR ${apitWithheld || "0"}. `,
                )
              }
              className="rounded-lg bg-brand-600 px-[18px] py-[9px] text-[13.5px] font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Ask a question about this
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
            >
              Download PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line-strong bg-white px-4 py-2 text-[13px] font-medium text-ink-700 transition-colors hover:border-brand-600 hover:text-brand-600"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[12.5px] font-medium text-ink-500">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-[14px] text-ink-900 outline-none focus:border-brand-600"
      />
    </label>
  );
}
