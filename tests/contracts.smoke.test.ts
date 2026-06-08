/**
 * Smoke test — confirms the locked contracts barrel imports and the default
 * policy is the prd.md §6 shape. Gives module agents a working vitest baseline.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY, MCP_TOOL_NAMES } from "@/contracts";

describe("contracts", () => {
  it("exposes the prd.md §6 default policy", () => {
    expect(DEFAULT_POLICY.highConfidence).toBe(0.85);
    expect(DEFAULT_POLICY.lowConfidence).toBe(0.6);
    expect(DEFAULT_POLICY.pricePctTolerance).toBe(0.02);
    expect(DEFAULT_POLICY.priceAbsTolerance).toBe(25);
    expect(DEFAULT_POLICY.maxLowConfidenceAutoSubmit).toBe(0);
  });

  it("locks the six MCP tool names", () => {
    expect(Object.values(MCP_TOOL_NAMES).sort()).toEqual(
      [
        "health",
        "list_sites",
        "list_sponsors",
        "list_studies",
        "list_study_sites",
        "search_catalog_items",
      ].sort(),
    );
  });
});
