/**
 * Pure presentation helpers shared across hub components. No business logic —
 * formatting, label maps, and lane/state classification for display only.
 */

import type {
  InvoiceState,
  Verdict,
  MatchOutcome,
  ResolutionStatus,
  StageStatus,
  StageName,
} from "@/contracts";

/** Confidence as a percentage string, e.g. 0.873 -> "87%". */
export function pct(confidence: number | undefined | null): string {
  if (confidence === undefined || confidence === null || Number.isNaN(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

/** Money in major units, e.g. 480 -> "$480.00". currency defaults to USD. */
export function money(
  amount: number | undefined | null,
  currency: string = "USD",
): string {
  if (amount === undefined || amount === null || Number.isNaN(amount)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Short relative-ish absolute timestamp for the queue + timeline. */
export function dateTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* --------------------------- Lane classification ------------------------- */

export type Lane = "submitted" | "held";

/** Which queue lane a state belongs to. Anything not yet decided counts as held/in-flight. */
export function laneForState(state: InvoiceState): Lane {
  return state === "SUBMITTED" ? "submitted" : "held";
}

/* ------------------------------- Badges ---------------------------------- */

export interface BadgeStyle {
  label: string;
  className: string;
}

const STATE_LABELS: Record<InvoiceState, string> = {
  RECEIVED: "Received",
  EXTRACTING: "Extracting",
  EXTRACTED: "Extracted",
  RESOLVING: "Resolving",
  CONTEXT_RESOLVED: "Context resolved",
  MATCHING: "Matching",
  MATCHED: "Matched",
  DECIDING: "Deciding",
  SUBMITTED: "Submitted",
  HELD: "Held",
  FAILED: "Failed",
};

export function stateBadge(state: InvoiceState): BadgeStyle {
  const label = STATE_LABELS[state] ?? state;
  let className = "bg-gray-100 text-gray-700 ring-gray-300";
  if (state === "SUBMITTED") className = "bg-emerald-100 text-emerald-800 ring-emerald-300";
  else if (state === "HELD") className = "bg-amber-100 text-amber-900 ring-amber-300";
  else if (state === "FAILED") className = "bg-rose-100 text-rose-800 ring-rose-300";
  else className = "bg-sky-100 text-sky-800 ring-sky-300"; // in-flight
  return { label, className };
}

export function verdictBadge(verdict: Verdict | undefined): BadgeStyle {
  if (verdict === "SUBMIT") {
    return { label: "SUBMIT", className: "bg-emerald-100 text-emerald-800 ring-emerald-300" };
  }
  if (verdict === "HOLD") {
    return { label: "HOLD", className: "bg-amber-100 text-amber-900 ring-amber-300" };
  }
  return { label: "Pending", className: "bg-gray-100 text-gray-600 ring-gray-300" };
}

const OUTCOME_LABELS: Record<MatchOutcome, string> = {
  matched_high: "Matched",
  matched_low: "Low confidence",
  ambiguous: "Ambiguous",
  unmatched: "Unmatched",
  price_mismatch: "Price mismatch",
};

export function outcomeBadge(outcome: MatchOutcome): BadgeStyle {
  const label = OUTCOME_LABELS[outcome] ?? outcome;
  let className = "bg-gray-100 text-gray-700 ring-gray-300";
  switch (outcome) {
    case "matched_high":
      className = "bg-emerald-100 text-emerald-800 ring-emerald-300";
      break;
    case "matched_low":
      className = "bg-yellow-100 text-yellow-800 ring-yellow-300";
      break;
    case "ambiguous":
      className = "bg-orange-100 text-orange-800 ring-orange-300";
      break;
    case "unmatched":
      className = "bg-rose-100 text-rose-800 ring-rose-300";
      break;
    case "price_mismatch":
      className = "bg-red-100 text-red-800 ring-red-300";
      break;
  }
  return { label, className };
}

/** A line item is an "exception" if its outcome is anything but a clean high match. */
export function isException(outcome: MatchOutcome): boolean {
  return outcome !== "matched_high";
}

const RESOLUTION_LABELS: Record<ResolutionStatus, string> = {
  resolved_high: "Resolved",
  resolved_corrected: "Resolved (corrected)",
  ambiguous: "Ambiguous",
  unresolved: "Unresolved",
};

export function resolutionBadge(status: ResolutionStatus): BadgeStyle {
  const label = RESOLUTION_LABELS[status] ?? status;
  let className = "bg-gray-100 text-gray-700 ring-gray-300";
  switch (status) {
    case "resolved_high":
      className = "bg-emerald-100 text-emerald-800 ring-emerald-300";
      break;
    case "resolved_corrected":
      className = "bg-blue-100 text-blue-800 ring-blue-300";
      break;
    case "ambiguous":
      className = "bg-orange-100 text-orange-800 ring-orange-300";
      break;
    case "unresolved":
      className = "bg-rose-100 text-rose-800 ring-rose-300";
      break;
  }
  return { label, className };
}

const STAGE_LABELS: Record<StageName, string> = {
  extract: "Extract",
  resolve: "Resolve",
  match: "Match",
  decide: "Decide",
};

export function stageLabel(stage: StageName): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function stageStatusStyle(status: StageStatus): { label: string; dot: string; text: string } {
  switch (status) {
    case "succeeded":
      return { label: "succeeded", dot: "bg-emerald-500", text: "text-emerald-700" };
    case "failed":
      return { label: "failed", dot: "bg-rose-500", text: "text-rose-700" };
    case "low_confidence":
      return { label: "low confidence", dot: "bg-yellow-500", text: "text-yellow-700" };
    case "retried":
      return { label: "retried", dot: "bg-orange-500", text: "text-orange-700" };
    case "started":
    default:
      return { label: "started", dot: "bg-sky-500", text: "text-sky-700" };
  }
}
