/**
 * Extract stage unit tests (FR2).
 *
 * Drives the REAL extractStage against a MockLlmClient whose completeStructured
 * returns canned metadata + line items over a fixed documentText. Asserts the
 * stage maps metadata/provenance/confidence and line items correctly into
 * ExtractOutput, and exercises the exception/normalization paths (empty document,
 * dropped malformed lines, derived overall confidence, numeric coercion).
 *
 * OFFLINE: no network, no DB.
 */

import { describe, it, expect } from "vitest";
import { extractStage } from "@/pipeline/extract";
import type {
  LlmClient,
  CompleteStructuredInput,
  CompleteStructuredResult,
  RunToolLoopInput,
  RunToolLoopResult,
  Logger,
  ModelInfo,
  StageDeps,
  ExtractInput,
} from "@/contracts";
import { DEFAULT_POLICY } from "@/contracts";

const MODEL_INFO: ModelInfo = {
  model: "mock-claude",
  promptVersion: "mock-v1",
  inputTokens: 120,
  outputTokens: 40,
};

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

/**
 * MockLlmClient whose completeStructured returns whatever raw extraction object
 * the test installed. runToolLoop is unused here (throws if called).
 */
class MockLlmClient implements LlmClient {
  raw: unknown = {};

  async completeStructured<T>(
    _input: CompleteStructuredInput<T>,
  ): Promise<CompleteStructuredResult<T>> {
    void _input;
    return { value: this.raw as T, modelInfo: MODEL_INFO };
  }

  async runToolLoop<T>(_input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>> {
    throw new Error("runToolLoop not used in extract tests");
  }
}

function deps(llm: LlmClient): StageDeps {
  // mcp is unused by extract; cast a minimal stub.
  return {
    llm,
    mcp: {} as StageDeps["mcp"],
    policy: DEFAULT_POLICY,
    logger: noopLogger,
  };
}

const INPUT: ExtractInput = {
  invoiceId: "inv-extract-1",
  documentText: "ACME Therapeutics — Invoice INV-42\nScreening visit ... $500\n",
  fileName: "acme-invoice.pdf",
};

describe("extractStage (FR2)", () => {
  it("maps provenanced metadata, line items, and confidence into ExtractOutput", async () => {
    const llm = new MockLlmClient();
    llm.raw = {
      metadata: {
        sponsorName: {
          value: "ACME Therapeutics",
          confidence: 0.92,
          provenance: { sourceText: "ACME Therapeutics", page: 1, locator: "header" },
        },
        protocolNumber: { value: "ACM-2024-7", confidence: 0.99 },
        total: { value: 1100, confidence: 0.9 },
      },
      lineItems: [
        {
          rawDescription: "Screening visit",
          quantity: 1,
          unitPrice: 500,
          amount: 500,
          confidence: 0.95,
          provenance: { sourceText: "Screening visit ... $500" },
        },
        {
          rawDescription: "Baseline visit",
          quantity: 1,
          unitPrice: 600,
          amount: 600,
          confidence: 0.9,
        },
      ],
      overallConfidence: 0.93,
    };

    const out = await extractStage(INPUT, deps(llm));

    // Metadata mapping + provenance preserved.
    expect(out.extracted.metadata.sponsorName?.value).toBe("ACME Therapeutics");
    expect(out.extracted.metadata.sponsorName?.confidence).toBeCloseTo(0.92);
    expect(out.extracted.metadata.sponsorName?.provenance).toEqual({
      sourceText: "ACME Therapeutics",
      page: 1,
      locator: "header",
    });
    expect(out.extracted.metadata.protocolNumber?.value).toBe("ACM-2024-7");
    expect(out.extracted.metadata.total?.value).toBe(1100);

    // Line items mapped in order with their fields.
    expect(out.extracted.lineItems).toHaveLength(2);
    expect(out.extracted.lineItems[0]).toMatchObject({
      rawDescription: "Screening visit",
      quantity: 1,
      unitPrice: 500,
      amount: 500,
      confidence: 0.95,
    });
    expect(out.extracted.lineItems[0].provenance?.sourceText).toBe(
      "Screening visit ... $500",
    );
    expect(out.extracted.lineItems[1].rawDescription).toBe("Baseline visit");

    // Overall confidence + modelInfo passthrough.
    expect(out.confidence).toBeCloseTo(0.93);
    expect(out.modelInfo).toEqual(MODEL_INFO);
  });

  it("throws EXTRACT_EMPTY_DOCUMENT on a blank text layer (exception path)", async () => {
    const llm = new MockLlmClient();
    await expect(
      extractStage({ ...INPUT, documentText: "   \n  " }, deps(llm)),
    ).rejects.toThrow(/EXTRACT_EMPTY_DOCUMENT/);
  });

  it("drops line items with no rawDescription and coerces stringy numbers", async () => {
    const llm = new MockLlmClient();
    llm.raw = {
      metadata: {
        // stringy number coerced; empty-string sponsor dropped.
        total: { value: "1,234.50", confidence: 0.8 },
        sponsorName: { value: "   ", confidence: 0.8 },
      },
      lineItems: [
        { rawDescription: "Valid line", confidence: 0.7, unitPrice: "100" },
        { rawDescription: "", confidence: 0.9 }, // dropped: no description
        { quantity: 2, confidence: 0.9 }, // dropped: no description
      ],
      overallConfidence: 0.88,
    };

    const out = await extractStage(INPUT, deps(llm));

    expect(out.extracted.metadata.total?.value).toBe(1234.5);
    // Empty/whitespace sponsor name is not carried.
    expect(out.extracted.metadata.sponsorName).toBeUndefined();

    expect(out.extracted.lineItems).toHaveLength(1);
    expect(out.extracted.lineItems[0].rawDescription).toBe("Valid line");
    expect(out.extracted.lineItems[0].unitPrice).toBe(100);
  });

  it("derives overall confidence when the model omits overallConfidence", async () => {
    const llm = new MockLlmClient();
    llm.raw = {
      metadata: { protocolNumber: { value: "P-1", confidence: 0.8 } },
      lineItems: [
        { rawDescription: "A", confidence: 0.6 },
        { rawDescription: "B", confidence: 1.0 },
      ],
      // overallConfidence omitted -> mean of [0.8, 0.6, 1.0] = 0.8
    };

    const out = await extractStage(INPUT, deps(llm));
    expect(out.confidence).toBeCloseTo((0.8 + 0.6 + 1.0) / 3, 5);
  });

  it("clamps an out-of-range overall confidence into [0,1]", async () => {
    const llm = new MockLlmClient();
    llm.raw = {
      metadata: {},
      lineItems: [{ rawDescription: "A", confidence: 0.5 }],
      overallConfidence: 1.7,
    };
    const out = await extractStage(INPUT, deps(llm));
    expect(out.confidence).toBe(1);
  });
});
