/**
 * Stream D — Decide policy unit tests (FR5, prd.md §6, §9).
 *
 * The verdict is owned by a PURE deterministic policy, so this is the most
 * heavily testable surface in the build. We exercise:
 *   - context-status gating (resolved_high / resolved_corrected / ambiguous /
 *     unresolved),
 *   - per-line-item outcome gating (matched_high / matched_low / ambiguous /
 *     unmatched / price_mismatch),
 *   - the 0.85 / 0.60 confidence boundary behavior (encoded as outcomes),
 *   - price-tolerance edges (±2% vs ±$25, whichever is larger),
 *   - the matched_low auto-submit limit,
 *   - totals reconciliation within tolerance,
 *   - and a table-driven test asserting the verdict for each of the four §9
 *     sample scenarios from representative resolution + match inputs.
 */

import { describe, it, expect } from "vitest";
import { decidePolicy, withinTolerance } from "@/pipeline/decide";
import { DEFAULT_POLICY } from "@/contracts";
import type {
  DecideInput,
  InvoiceMetadata,
  MatchedLineItem,
  MatchOutcome,
  PolicyConfig,
  ResolutionStatus,
  ResolveOutput,
} from "@/contracts";

/* ------------------------------ builders -------------------------------- */

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { ...DEFAULT_POLICY, ...overrides };
}

function resolution(
  status: ResolutionStatus,
  overrides: Partial<ResolveOutput> = {},
): ResolveOutput {
  return {
    status,
    confidence: status === "resolved_high" ? 0.95 : 0.7,
    sponsorId: 1,
    studyId: 2,
    siteId: 3,
    studySiteId: 4,
    evidence: { candidates: [] },
    ...overrides,
  };
}

let lineCounter = 0;
function line(
  outcome: MatchOutcome,
  overrides: Partial<MatchedLineItem> = {},
): MatchedLineItem {
  const index = overrides.index ?? lineCounter++;
  return {
    index,
    rawDescription: overrides.rawDescription ?? `item-${index}`,
    confidence: overrides.confidence ?? 0.9,
    outcome,
    matchConfidence: overrides.matchConfidence,
    matchedItemId: overrides.matchedItemId,
    quantity: overrides.quantity,
    unitPrice: overrides.unitPrice,
    amount: overrides.amount,
    candidates: overrides.candidates,
    rationale: overrides.rationale,
    provenance: overrides.provenance,
  };
}

function metadata(total?: number): InvoiceMetadata {
  if (total === undefined) return {};
  return { total: { value: total, confidence: 1 } };
}

function decideInput(
  res: ResolveOutput,
  items: MatchedLineItem[],
  meta: InvoiceMetadata = {},
): DecideInput {
  return {
    invoiceId: "inv-test",
    resolution: res,
    match: { items },
    metadata: meta,
  };
}

const codes = (record: { reasons: { code: string }[] }) =>
  record.reasons.map((r) => r.code);

/* --------------------------- withinTolerance ---------------------------- */

describe("withinTolerance", () => {
  const p = policy(); // 2% / $25

  it("uses the absolute $25 floor when it is larger than 2%", () => {
    // 2% of 100 = $2, so the $25 floor dominates.
    expect(withinTolerance(100, 120, p)).toBe(true); // diff 20 < 25
    expect(withinTolerance(100, 126, p)).toBe(false); // diff 26 > 25
  });

  it("uses the 2% band when it is larger than $25", () => {
    // 2% of 10_000 = $200, which beats the $25 floor.
    expect(withinTolerance(10_000, 10_150, p)).toBe(true); // diff 150 < 200
    expect(withinTolerance(10_000, 10_300, p)).toBe(false); // diff 300 > 200
  });

  it("treats the exact tolerance edge as within (inclusive)", () => {
    expect(withinTolerance(100, 125, p)).toBe(true); // diff exactly 25
    // exactly 2% of the larger value (10_000): 200
    expect(withinTolerance(10_000, 10_200, p)).toBe(true);
  });

  it("is symmetric in its arguments", () => {
    expect(withinTolerance(126, 100, p)).toBe(false);
    expect(withinTolerance(100, 126, p)).toBe(false);
  });
});

/* ----------------------------- context gate ----------------------------- */

describe("decidePolicy — context gate", () => {
  it("SUBMITs on resolved_high with all clean items + reconciled totals", () => {
    const r = decidePolicy(
      decideInput(
        resolution("resolved_high"),
        [
          line("matched_high", { amount: 50 }),
          line("matched_high", { amount: 50 }),
        ],
        metadata(100),
      ),
      policy(),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).toContain("context_resolved");
    expect(codes(r)).toContain("all_line_items_matched");
    expect(codes(r)).toContain("totals_reconciled");
    expect(r.policyVersion).toBe("policy-v1");
  });

  it("HOLDs on ambiguous context even when items are clean", () => {
    const r = decidePolicy(
      decideInput(resolution("ambiguous"), [line("matched_high", { amount: 10 })]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("context_ambiguous");
  });

  it("HOLDs on unresolved context", () => {
    const r = decidePolicy(
      decideInput(resolution("unresolved"), [line("matched_high", { amount: 10 })]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("context_unresolved");
  });

  it("HOLDs on resolved_corrected (correction needs QC confirmation)", () => {
    const r = decidePolicy(
      decideInput(
        resolution("resolved_corrected", {
          evidence: {
            candidates: [],
            corrections: [{ field: "sponsorName", statedValue: "Acme", resolvedValue: "Northwind" }],
          },
        }),
        [line("matched_high", { amount: 10 })],
      ),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("context_corrected_needs_confirmation");
    // evidence carries the corrections so the hub can render WHY.
    const reason = r.reasons.find((x) => x.code === "context_corrected_needs_confirmation");
    expect(reason?.evidence?.corrections).toBeTruthy();
  });
});

/* --------------------------- line-item gate ----------------------------- */

describe("decidePolicy — line-item gate", () => {
  const ok = resolution("resolved_high");

  it("HOLDs when any item is price_mismatch", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 10 }), line("price_mismatch", { amount: 10 })]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("line_item_price_mismatch");
  });

  it("HOLDs when any item is unmatched", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high"), line("unmatched")]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("line_item_unmatched");
  });

  it("HOLDs when any item is ambiguous", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high"), line("ambiguous")]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("line_item_ambiguous");
  });

  it("price_mismatch reason carries extracted vs catalog price evidence", () => {
    const r = decidePolicy(
      decideInput(ok, [
        line("price_mismatch", {
          matchedItemId: 42,
          unitPrice: 120,
          amount: 120,
          candidates: [
            { catalogItemId: 42, itemCode: "CAT-42", description: "x", catalogUnitPrice: 100, confidence: 0.9 },
          ],
        }),
      ]),
      policy(),
    );
    const reason = r.reasons.find((x) => x.code === "line_item_price_mismatch");
    expect(reason?.evidence?.extractedUnitPrice).toBe(120);
    expect(reason?.evidence?.catalogUnitPrice).toBe(100);
  });
});

/* ----------------------- matched_low auto-submit limit ------------------ */

describe("decidePolicy — matched_low limit (0.60–0.85 band)", () => {
  const ok = resolution("resolved_high");

  it("HOLDs a single matched_low under the default limit of 0", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 10 }), line("matched_low", { amount: 10 })], metadata(20)),
      policy(), // maxLowConfidenceAutoSubmit = 0
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("line_item_low_confidence_over_limit");
  });

  it("SUBMITs matched_low items when within the configured limit", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 10 }), line("matched_low", { amount: 10 })], metadata(20)),
      policy({ maxLowConfidenceAutoSubmit: 1 }),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).not.toContain("line_item_low_confidence_over_limit");
  });

  it("HOLDs when matched_low count exceeds the configured limit", () => {
    const r = decidePolicy(
      decideInput(
        ok,
        [line("matched_low", { amount: 10 }), line("matched_low", { amount: 10 })],
        metadata(20),
      ),
      policy({ maxLowConfidenceAutoSubmit: 1 }),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("line_item_low_confidence_over_limit");
    const reason = r.reasons.find((x) => x.code === "line_item_low_confidence_over_limit");
    expect(reason?.evidence?.lowConfidenceCount).toBe(2);
  });
});

/* ----------------------------- totals gate ------------------------------ */

describe("decidePolicy — totals reconciliation", () => {
  const ok = resolution("resolved_high");

  it("SUBMITs when stated total reconciles within tolerance (abs $25 floor)", () => {
    // line sum 100, stated 120 → diff 20 < $25 floor.
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 60 }), line("matched_high", { amount: 40 })], metadata(120)),
      policy(),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).toContain("totals_reconciled");
  });

  it("HOLDs when stated total drifts beyond tolerance", () => {
    // line sum 100, stated 200 → diff 100 > max(2%*200=4, $25).
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 60 }), line("matched_high", { amount: 40 })], metadata(200)),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    expect(codes(r)).toContain("totals_mismatch");
    const reason = r.reasons.find((x) => x.code === "totals_mismatch");
    expect(reason?.evidence?.statedTotal).toBe(200);
    expect(reason?.evidence?.lineSum).toBe(100);
  });

  it("derives line amounts from quantity * unitPrice when amount is absent", () => {
    const r = decidePolicy(
      decideInput(
        ok,
        [line("matched_high", { quantity: 2, unitPrice: 50 })], // → 100
        metadata(100),
      ),
      policy(),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).toContain("totals_reconciled");
  });

  it("skips totals reconciliation when no stated total is present", () => {
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 100 })], metadata(undefined)),
      policy(),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).not.toContain("totals_mismatch");
    expect(codes(r)).not.toContain("totals_reconciled");
  });

  it("reconciles at the exact 2% edge for a large invoice", () => {
    // line sum 10_000, stated 10_200 → diff 200 == 2% of 10_200... use larger ref.
    const r = decidePolicy(
      decideInput(ok, [line("matched_high", { amount: 10_000 })], metadata(10_200)),
      policy(),
    );
    expect(r.verdict).toBe("SUBMIT");
    expect(codes(r)).toContain("totals_reconciled");
  });
});

/* ------------------------- ranking & determinism ------------------------ */

describe("decidePolicy — reason ranking and purity", () => {
  it("on HOLD returns only HOLD reasons, context first", () => {
    const r = decidePolicy(
      decideInput(resolution("ambiguous"), [line("unmatched"), line("price_mismatch", { amount: 5 })]),
      policy(),
    );
    expect(r.verdict).toBe("HOLD");
    // Context reason ranked first (most decision-driving).
    expect(r.reasons[0].code).toBe("context_ambiguous");
    // No SUBMIT confirmations leak into a HOLD record.
    expect(codes(r)).not.toContain("totals_reconciled");
    expect(codes(r)).not.toContain("all_line_items_matched");
  });

  it("is a pure function — same input yields identical output", () => {
    const input = decideInput(
      resolution("resolved_high"),
      [line("matched_high", { amount: 100 })],
      metadata(100),
    );
    const a = decidePolicy(input, policy());
    const b = decidePolicy(input, policy());
    expect(a).toEqual(b);
  });

  it("stamps the policyVersion from config onto the record", () => {
    const r = decidePolicy(
      decideInput(resolution("resolved_high"), [line("matched_high", { amount: 1 })], metadata(1)),
      policy({ policyVersion: "policy-v2-custom" }),
    );
    expect(r.policyVersion).toBe("policy-v2-custom");
  });
});

/* -------------------- §9 sample-scenario table-driven test -------------- */

describe("decidePolicy — prd.md §9 sample scenarios", () => {
  type Scenario = {
    name: string;
    resolution: ResolveOutput;
    items: MatchedLineItem[];
    total: number;
    expected: "SUBMIT" | "HOLD";
    expectCode?: string;
  };

  const scenarios: Scenario[] = [
    {
      // simple-invoice.pdf — resolved_high, 5 matched_high, totals reconcile → SUBMIT.
      name: "simple-invoice: resolved_high + all matched_high → SUBMIT",
      resolution: resolution("resolved_high"),
      items: Array.from({ length: 5 }, (_, i) =>
        line("matched_high", { index: i, amount: 100 }),
      ),
      total: 500,
      expected: "SUBMIT",
      expectCode: "all_line_items_matched",
    },
    {
      // medium-invoice.pdf — resolved, 10 clean + 1 price_mismatch → HOLD.
      name: "medium-invoice: one price_mismatch among clean → HOLD",
      resolution: resolution("resolved_high"),
      items: [
        ...Array.from({ length: 10 }, (_, i) => line("matched_high", { index: i, amount: 100 })),
        line("price_mismatch", { index: 10, amount: 100 }),
      ],
      total: 1100,
      expected: "HOLD",
      expectCode: "line_item_price_mismatch",
    },
    {
      // large-invoice.pdf — resolved, 1 price_mismatch + ambiguous + 3 unmatched → HOLD.
      name: "large-invoice: price_mismatch + ambiguous + 3 unmatched → HOLD",
      resolution: resolution("resolved_high"),
      items: [
        ...Array.from({ length: 22 }, (_, i) => line("matched_high", { index: i, amount: 100 })),
        line("price_mismatch", { index: 22, amount: 100 }),
        line("ambiguous", { index: 23 }),
        line("unmatched", { index: 24 }),
        line("unmatched", { index: 25 }),
        line("unmatched", { index: 26 }),
      ],
      total: 2700,
      expected: "HOLD",
      expectCode: "line_item_unmatched",
    },
    {
      // mismatched-metadata-invoice.pdf — resolved_corrected → HOLD for confirmation.
      name: "mismatched-metadata: resolved_corrected → HOLD for QC confirmation",
      resolution: resolution("resolved_corrected", {
        confidence: 0.88,
        evidence: {
          candidates: [],
          corrections: [
            { field: "sponsorName", statedValue: "Wrong Pharma", resolvedValue: "Northwind Pharma" },
          ],
        },
      }),
      items: Array.from({ length: 7 }, (_, i) => line("matched_high", { index: i, amount: 100 })),
      total: 700,
      expected: "HOLD",
      expectCode: "context_corrected_needs_confirmation",
    },
  ];

  it.each(scenarios)("$name", (s) => {
    const r = decidePolicy(
      decideInput(s.resolution, s.items, metadata(s.total)),
      policy(),
    );
    expect(r.verdict).toBe(s.expected);
    if (s.expectCode) expect(codes(r)).toContain(s.expectCode);
  });
});
