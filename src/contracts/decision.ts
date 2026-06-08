/**
 * Decision contracts — the deterministic policy's vocabulary and output.
 * Mirrors prd.md §6 (decision model) and architecture.md §3 (Decision).
 *
 * The verdict is owned by a deterministic policy, NOT the LLM (architecture.md
 * §6) — that is what makes it testable and reproducible.
 *
 * LOCKED CONTRACT.
 */

/** Context-resolution status (prd.md §6 "Context resolution outcomes"). */
export type ResolutionStatus =
  | "resolved_high" // unique, confident
  | "resolved_corrected" // resolved after reconciling conflicting metadata
  | "ambiguous" // multiple candidates
  | "unresolved"; // no confident match

/** Per-line-item match outcome (prd.md §6 "Line-item match outcomes"). */
export type MatchOutcome =
  | "matched_high" // single best candidate ≥ highConfidence, price in tolerance
  | "matched_low" // best candidate in [lowConfidence, highConfidence)
  | "ambiguous" // top candidates within a small margin of each other
  | "unmatched" // no candidate ≥ lowConfidence
  | "price_mismatch"; // matched but price deviates beyond tolerance

/** Invoice-level verdict. */
export type Verdict = "SUBMIT" | "HOLD";

/**
 * Stable machine-readable reason codes for a verdict. Used by both the policy
 * and the hub (to render and group reasons). Extend deliberately.
 */
export type DecisionReasonCode =
  // HOLD reasons
  | "context_ambiguous"
  | "context_unresolved"
  | "context_corrected_needs_confirmation"
  | "line_item_unmatched"
  | "line_item_ambiguous"
  | "line_item_price_mismatch"
  | "line_item_low_confidence_over_limit"
  | "totals_mismatch"
  // SUBMIT reasons
  | "context_resolved"
  | "all_line_items_matched"
  | "totals_reconciled";

/** One triggering reason in a decision record, with supporting evidence. */
export interface DecisionReason {
  code: DecisionReasonCode;
  /** Human-readable explanation, rendered verbatim in the hub. */
  message: string;
  /**
   * Structured evidence backing the reason — e.g. which line index, the
   * extracted vs catalog price, the candidate ids considered. Free-form so each
   * reason can attach what's relevant.
   */
  evidence?: Record<string, unknown>;
}

/**
 * The stored decision record (architecture.md §3 Decision). The hub renders this
 * verbatim so a reviewer sees exactly why the AI submitted or held.
 */
export interface DecisionRecord {
  verdict: Verdict;
  /** Ranked: the most decision-driving reason first. */
  reasons: DecisionReason[];
  /** Version of the policy/config that produced this verdict. */
  policyVersion: string;
}

/**
 * Tunable decision policy (prd.md §6 — "Thresholds and tolerances are
 * configuration, not hard-coded"). Defaults are the prd.md values.
 */
export interface PolicyConfig {
  /** Confidence at/above which a match is `matched_high`. Default 0.85. */
  highConfidence: number;
  /** Confidence floor for any match; below this is `unmatched`. Default 0.60. */
  lowConfidence: number;
  /** Relative price tolerance (fraction). Default 0.02 (±2%). */
  pricePctTolerance: number;
  /** Absolute price tolerance in major units. Default 25 (±$25). */
  priceAbsTolerance: number;
  /**
   * How many `matched_low` line items are allowed before HOLD. Default 0
   * (any low-confidence match holds for QC).
   */
  maxLowConfidenceAutoSubmit: number;
  /** Identifier stamped onto every DecisionRecord.policyVersion. */
  policyVersion: string;
}

/** The prd.md §6 default policy values. */
export const DEFAULT_POLICY: PolicyConfig = {
  highConfidence: 0.85,
  lowConfidence: 0.6,
  pricePctTolerance: 0.02,
  priceAbsTolerance: 25,
  maxLowConfidenceAutoSubmit: 0,
  policyVersion: "policy-v1",
};
