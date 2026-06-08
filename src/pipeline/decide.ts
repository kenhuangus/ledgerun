/**
 * Decide stage (FR5) — deterministic submit/hold policy. Owned by Stream D.
 *
 * The verdict is owned by a PURE policy function over:
 *   - the context ResolutionStatus,
 *   - the per-line-item MatchOutcome[],
 *   - totals reconciliation (stated total vs. sum of line amounts),
 *   - the PolicyConfig thresholds/tolerances.
 *
 * NO LLM owns the verdict (architecture.md §6 — "policy, not prompt, owns the
 * verdict"). This keeps it explainable and testable. See prd.md §6 for the exact
 * threshold/tolerance/verdict rules.
 *
 * HOLD if ANY of:
 *   - context is `ambiguous` or `unresolved`,
 *   - context is `resolved_corrected` (correction needs QC confirmation, per
 *     prd.md §9 mismatched-metadata scenario),
 *   - any line item is `price_mismatch`, `unmatched`, or `ambiguous`,
 *   - the count of `matched_low` items exceeds maxLowConfidenceAutoSubmit,
 *   - the stated invoice total does not reconcile with the sum of line amounts
 *     within tolerance.
 * SUBMIT otherwise.
 *
 * Each reason carries structured `evidence` so the hub can render WHY verbatim.
 */

import type {
  DecideStage,
  DecideInput,
  DecisionRecord,
  DecisionReason,
  MatchedLineItem,
  PolicyConfig,
  Verdict,
} from "@/contracts";

/**
 * Whether two monetary amounts reconcile within the policy tolerance.
 * Tolerance is the LARGER of (pricePctTolerance * reference) and
 * priceAbsTolerance (prd.md §6: "±2% or ±$25, whichever is larger"). The
 * percentage is taken against the larger-magnitude of the two values so a near-
 * zero reference doesn't collapse the relative band.
 */
export function withinTolerance(
  a: number,
  b: number,
  policy: PolicyConfig,
): boolean {
  const diff = Math.abs(a - b);
  const reference = Math.max(Math.abs(a), Math.abs(b));
  const tolerance = Math.max(
    policy.pricePctTolerance * reference,
    policy.priceAbsTolerance,
  );
  // Use a tiny epsilon so an exact-edge diff counts as within tolerance.
  return diff <= tolerance + 1e-9;
}

/**
 * Sum of stated line amounts. A line contributes its `amount` when present,
 * else `quantity * unitPrice` when both are present, else nothing (and the line
 * is reported so the caller can decide whether reconciliation is meaningful).
 */
function sumLineAmounts(items: MatchedLineItem[]): {
  total: number;
  contributing: number;
} {
  let total = 0;
  let contributing = 0;
  for (const it of items) {
    if (typeof it.amount === "number" && Number.isFinite(it.amount)) {
      total += it.amount;
      contributing += 1;
    } else if (
      typeof it.quantity === "number" &&
      typeof it.unitPrice === "number" &&
      Number.isFinite(it.quantity) &&
      Number.isFinite(it.unitPrice)
    ) {
      total += it.quantity * it.unitPrice;
      contributing += 1;
    }
  }
  return { total, contributing };
}

/** A short human label for a line item, for reason messages. */
function lineLabel(it: MatchedLineItem): string {
  const desc = it.rawDescription?.trim() ?? "";
  const short = desc.length > 60 ? `${desc.slice(0, 57)}...` : desc;
  return short || `line ${it.index}`;
}

/**
 * The pure policy core. Exposed separately from the stage wrapper so unit tests
 * can call it without constructing StageDeps. Reasons are returned ranked: the
 * most decision-driving (HOLD-causing) reasons first, then confirmations.
 */
export function decidePolicy(input: DecideInput, policy: PolicyConfig): DecisionRecord {
  const { resolution, match, metadata } = input;
  const items = match.items ?? [];

  const holdReasons: DecisionReason[] = [];
  const submitReasons: DecisionReason[] = [];

  /* ---------------------------- Context gate ---------------------------- */
  switch (resolution.status) {
    case "unresolved":
      holdReasons.push({
        code: "context_unresolved",
        message:
          "Clinical-trial context (sponsor/study/site) could not be confidently resolved.",
        evidence: {
          status: resolution.status,
          confidence: resolution.confidence,
          sponsorId: resolution.sponsorId,
          studyId: resolution.studyId,
          siteId: resolution.siteId,
        },
      });
      break;
    case "ambiguous":
      holdReasons.push({
        code: "context_ambiguous",
        message:
          "Multiple candidate sponsors/studies/sites matched; context is ambiguous.",
        evidence: {
          status: resolution.status,
          confidence: resolution.confidence,
          candidates: resolution.evidence?.candidates,
        },
      });
      break;
    case "resolved_corrected":
      holdReasons.push({
        code: "context_corrected_needs_confirmation",
        message:
          "Context was resolved after reconciling conflicting invoice metadata; the correction needs QC confirmation.",
        evidence: {
          status: resolution.status,
          confidence: resolution.confidence,
          sponsorId: resolution.sponsorId,
          studyId: resolution.studyId,
          siteId: resolution.siteId,
          corrections: resolution.evidence?.corrections,
        },
      });
      break;
    case "resolved_high":
      submitReasons.push({
        code: "context_resolved",
        message: "Clinical-trial context resolved uniquely and confidently.",
        evidence: {
          status: resolution.status,
          confidence: resolution.confidence,
          sponsorId: resolution.sponsorId,
          studyId: resolution.studyId,
          siteId: resolution.siteId,
        },
      });
      break;
    default: {
      // Exhaustiveness guard — an unknown status is treated as unresolved.
      const _exhaustive: never = resolution.status;
      void _exhaustive;
      holdReasons.push({
        code: "context_unresolved",
        message: "Context resolution returned an unrecognized status.",
        evidence: { status: resolution.status },
      });
    }
  }

  /* -------------------------- Line-item gate ---------------------------- */
  const unmatched = items.filter((i) => i.outcome === "unmatched");
  const ambiguousItems = items.filter((i) => i.outcome === "ambiguous");
  const priceMismatch = items.filter((i) => i.outcome === "price_mismatch");
  const matchedLow = items.filter((i) => i.outcome === "matched_low");

  for (const it of priceMismatch) {
    holdReasons.push({
      code: "line_item_price_mismatch",
      message: `Line ${it.index} ("${lineLabel(it)}") price deviates beyond tolerance from its matched catalog item.`,
      evidence: {
        index: it.index,
        rawDescription: it.rawDescription,
        matchedItemId: it.matchedItemId,
        extractedUnitPrice: it.unitPrice,
        extractedAmount: it.amount,
        catalogUnitPrice: it.candidates?.find(
          (c) => c.catalogItemId === it.matchedItemId,
        )?.catalogUnitPrice,
        matchConfidence: it.matchConfidence,
      },
    });
  }
  for (const it of unmatched) {
    holdReasons.push({
      code: "line_item_unmatched",
      message: `Line ${it.index} ("${lineLabel(it)}") did not match any catalog item with sufficient confidence.`,
      evidence: {
        index: it.index,
        rawDescription: it.rawDescription,
        matchConfidence: it.matchConfidence,
        candidates: it.candidates,
      },
    });
  }
  for (const it of ambiguousItems) {
    holdReasons.push({
      code: "line_item_ambiguous",
      message: `Line ${it.index} ("${lineLabel(it)}") matched multiple catalog items within a small margin.`,
      evidence: {
        index: it.index,
        rawDescription: it.rawDescription,
        candidates: it.candidates,
      },
    });
  }

  // matched_low does not block on its own, but more than the allowed count does.
  if (matchedLow.length > policy.maxLowConfidenceAutoSubmit) {
    holdReasons.push({
      code: "line_item_low_confidence_over_limit",
      message: `${matchedLow.length} low-confidence line match(es) exceed the auto-submit limit of ${policy.maxLowConfidenceAutoSubmit}.`,
      evidence: {
        lowConfidenceCount: matchedLow.length,
        maxLowConfidenceAutoSubmit: policy.maxLowConfidenceAutoSubmit,
        indices: matchedLow.map((i) => i.index),
      },
    });
  }

  /* --------------------------- Totals gate ------------------------------ */
  const statedTotal = metadata.total?.value;
  const { total: lineSum, contributing } = sumLineAmounts(items);
  if (
    typeof statedTotal === "number" &&
    Number.isFinite(statedTotal) &&
    contributing > 0
  ) {
    if (!withinTolerance(statedTotal, lineSum, policy)) {
      holdReasons.push({
        code: "totals_mismatch",
        message: `Stated invoice total (${statedTotal}) does not reconcile with the sum of line amounts (${lineSum}) within tolerance.`,
        evidence: {
          statedTotal,
          lineSum,
          difference: statedTotal - lineSum,
          contributingLines: contributing,
          pricePctTolerance: policy.pricePctTolerance,
          priceAbsTolerance: policy.priceAbsTolerance,
        },
      });
    } else {
      submitReasons.push({
        code: "totals_reconciled",
        message: "Stated invoice total reconciles with the sum of line amounts.",
        evidence: { statedTotal, lineSum, contributingLines: contributing },
      });
    }
  }

  /* ------------------------------ Verdict ------------------------------- */
  // All clean line items confirmation (only meaningful when nothing held them).
  const allItemsClean =
    items.length > 0 &&
    unmatched.length === 0 &&
    ambiguousItems.length === 0 &&
    priceMismatch.length === 0 &&
    matchedLow.length <= policy.maxLowConfidenceAutoSubmit;
  if (allItemsClean) {
    submitReasons.push({
      code: "all_line_items_matched",
      message: "All line items matched the scoped catalog within policy.",
      evidence: {
        lineCount: items.length,
        matchedHigh: items.filter((i) => i.outcome === "matched_high").length,
        matchedLow: matchedLow.length,
      },
    });
  }

  const verdict: Verdict = holdReasons.length > 0 ? "HOLD" : "SUBMIT";
  // Ranked: HOLD-driving reasons first (in detection order), then confirmations.
  const reasons = verdict === "HOLD" ? holdReasons : submitReasons;

  return {
    verdict,
    reasons,
    policyVersion: policy.policyVersion,
  };
}

export const decideStage: DecideStage = async (input, deps) => {
  const log = deps.logger.child({ invoiceId: input.invoiceId, stage: "decide" });
  const record = decidePolicy(input, deps.policy);
  log.info(
    {
      verdict: record.verdict,
      reasonCodes: record.reasons.map((r) => r.code),
      policyVersion: record.policyVersion,
    },
    "decide verdict",
  );
  return record;
};

export default decideStage;
