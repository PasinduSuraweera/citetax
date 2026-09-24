/**
 * The worked example shown on the homepage and the sign-in screen.
 *
 * Computed by the engine when the page renders, never typed in, so what it
 * shows is exactly what the chat would answer. Null when the API cannot be
 * reached, and the pages then leave the example out.
 */

import { API_BASE, type ComputeResponse, type Snapshot } from "./api";

export const SAMPLE_MONTHLY = "250000";
export const SAMPLE_YA = "2026/2027";

export async function sampleLedger(): Promise<ComputeResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/compute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ya: SAMPLE_YA, employment_income: String(Number(SAMPLE_MONTHLY) * 12) }),
      next: { revalidate: 3600 },
    });
    return res.ok ? ((await res.json()) as ComputeResponse) : null;
  } catch {
    return null;
  }
}

export async function currentSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${API_BASE}/v1/snapshot/current`, { next: { revalidate: 3600 } });
    return res.ok ? ((await res.json()) as Snapshot) : null;
  } catch {
    return null;
  }
}
