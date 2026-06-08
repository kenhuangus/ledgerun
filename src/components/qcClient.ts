"use client";

/** Client-side wrappers around the QC + rerun API routes. Thin fetch helpers. */
import type { QcAction, QcActionResult, StageName } from "@/contracts";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function applyQcAction(invoiceId: string, action: QcAction): Promise<QcActionResult> {
  return postJson<QcActionResult>(`/api/invoices/${invoiceId}/qc`, action);
}

export function rerunInvoice(invoiceId: string, fromStage?: StageName): Promise<QcActionResult> {
  return postJson<QcActionResult>(`/api/invoices/${invoiceId}/rerun`, { fromStage });
}
