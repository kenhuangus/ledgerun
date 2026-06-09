/**
 * Match stage unit tests (FR4).
 *
 * Drives the REAL matchStage against a MockMcpClient returning a SMALL catalog
 * (incl. an acronym item LAB-CBC / "CBC") and a mock LlmClient whose pick is
 * derived from the prompt. Asserts:
 *   - the acronym line "Complete Blood Count" matches "CBC" (small-catalog
 *     full-candidate path — the whole catalog is offered, no lexical drop)
 *   - a price beyond tolerance yields outcome "price_mismatch"
 *   - a no-candidate line yields "unmatched"
 *   - a missing resolved scope marks every line unmatched (no throw, NFR4)
 *   - with a catalog > 50 items, the lexical shortlist path runs without error
 *
 * OFFLINE: no network, no DB.
 */

import { describe, it, expect } from "vitest";
import { matchStage } from "@/pipeline/match";
import { DEFAULT_POLICY } from "@/contracts";
import type {
  LlmClient,
  CompleteStructuredInput,
  CompleteStructuredResult,
  RunToolLoopInput,
  RunToolLoopResult,
  McpClient,
  Sponsor,
  Study,
  Site,
  StudySite,
  CatalogItem,
  Paginated,
  SearchCatalogItemsInput,
  Logger,
  ModelInfo,
  StageDeps,
  MatchInput,
  ExtractedLineItem,
} from "@/contracts";

const MODEL_INFO: ModelInfo = {
  model: "mock-claude",
  promptVersion: "match-mock",
  inputTokens: 150,
  outputTokens: 30,
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

/** Small acronym-bearing catalog: "CBC" is the abbreviation of Complete Blood Count. */
const SMALL_CATALOG: CatalogItem[] = [
  { id: 101, sponsorId: 1, studyId: 11, itemCode: "LAB-CBC", description: "CBC", unitPrice: 50 },
  { id: 102, sponsorId: 1, studyId: 11, itemCode: "PV-001", description: "Screening visit", unitPrice: 500 },
  { id: 103, sponsorId: 1, studyId: 11, itemCode: "PROC-020", description: "ECG twelve lead", unitPrice: 200 },
];

class MockMcpClient implements McpClient {
  catalog: CatalogItem[];
  searchCalls: SearchCatalogItemsInput[] = [];

  constructor(catalog: CatalogItem[]) {
    this.catalog = catalog;
  }
  async listSponsors(): Promise<Sponsor[]> {
    return [];
  }
  async listStudies(): Promise<Study[]> {
    return [];
  }
  async listSites(): Promise<Site[]> {
    return [];
  }
  async listStudySites(): Promise<StudySite[]> {
    return [];
  }
  async searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>> {
    this.searchCalls.push(input);
    // Single-page: whole catalog returned regardless of page size.
    return {
      items: this.catalog,
      total: this.catalog.length,
      page: 1,
      pageSize: input.pageSize ?? 200,
      pages: 1,
    };
  }
  async health() {
    return { ok: true, status: "ok" };
  }
}

/**
 * Mock LLM that derives a pick from the candidate prompt. It parses the line
 * Description and the offered id=NNN candidates (mirroring how match.ts builds
 * the prompt), then matches by an explicit semantic map (so the "acronym" case
 * is decided by the model, not by lexical overlap).
 */
class MockLlmClient implements LlmClient {
  catalog: CatalogItem[];
  /** description (lowercased) -> catalog id the "model" should choose. */
  semanticMap: Record<string, number> = {};

  constructor(catalog: CatalogItem[]) {
    this.catalog = catalog;
  }

  async completeStructured<T>(
    input: CompleteStructuredInput<T>,
  ): Promise<CompleteStructuredResult<T>> {
    const userMsg = input.messages.map((m) => m.content).join("\n");
    const lineDesc = (/Description:\s*"([^"]*)"/.exec(userMsg)?.[1] ?? "").toLowerCase();
    const candIds = Array.from(userMsg.matchAll(/id=(\d+)/g)).map((m) => Number(m[1]));

    const wantedId = this.semanticMap[lineDesc];
    if (wantedId != null && candIds.includes(wantedId)) {
      return {
        value: {
          catalogItemId: wantedId,
          confidence: 0.95,
          rationale: `Semantic match for "${lineDesc}".`,
          alternates: [],
        } as T,
        modelInfo: MODEL_INFO,
      };
    }
    // No genuine semantic match in the offered shortlist.
    return {
      value: {
        catalogItemId: null,
        confidence: 0.1,
        rationale: "No candidate matches.",
        alternates: [],
      } as T,
      modelInfo: MODEL_INFO,
    };
  }

  async runToolLoop<T>(_input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>> {
    throw new Error("runToolLoop not used in match tests");
  }
}

function deps(llm: LlmClient, mcp: McpClient): StageDeps {
  return { llm, mcp, policy: DEFAULT_POLICY, logger: noopLogger };
}

function line(rawDescription: string, extra: Partial<ExtractedLineItem> = {}): ExtractedLineItem {
  return { rawDescription, confidence: 0.95, ...extra };
}

describe("matchStage (FR4)", () => {
  it("matches an acronym line via the small-catalog full-candidate path", async () => {
    const mcp = new MockMcpClient(SMALL_CATALOG);
    const llm = new MockLlmClient(SMALL_CATALOG);
    // The "model" knows the clinical synonym CBC == Complete Blood Count.
    llm.semanticMap = { "complete blood count": 101 };

    const input: MatchInput = {
      invoiceId: "inv-m1",
      sponsorId: 1,
      studyId: 11,
      lineItems: [line("Complete Blood Count", { unitPrice: 50, amount: 50, quantity: 1 })],
    };
    const out = await matchStage(input, deps(llm, mcp));

    expect(out.items).toHaveLength(1);
    expect(out.items[0].matchedItemId).toBe(101);
    expect(out.items[0].outcome).toBe("matched_high");
    expect(out.catalogSize).toBe(3);
    // The acronym item was actually offered to the model (full catalog, not shortlisted away).
    expect(out.items[0].candidates?.some((c) => c.catalogItemId === 101)).toBe(true);
    expect(out.modelInfo).toEqual(MODEL_INFO);
  });

  it("flags a matched line whose price is beyond tolerance as price_mismatch", async () => {
    const mcp = new MockMcpClient(SMALL_CATALOG);
    const llm = new MockLlmClient(SMALL_CATALOG);
    llm.semanticMap = { "screening visit": 102 };

    // catalog unitPrice for 102 is 500; bill 700 — well past max(±2%, ±$25).
    const input: MatchInput = {
      invoiceId: "inv-m2",
      sponsorId: 1,
      studyId: 11,
      lineItems: [line("Screening visit", { unitPrice: 700, amount: 700, quantity: 1 })],
    };
    const out = await matchStage(input, deps(llm, mcp));

    expect(out.items[0].matchedItemId).toBe(102);
    expect(out.items[0].outcome).toBe("price_mismatch");
    expect(out.items[0].rationale).toMatch(/price out of tolerance/i);
  });

  it("yields unmatched when the model finds no genuine candidate", async () => {
    const mcp = new MockMcpClient(SMALL_CATALOG);
    const llm = new MockLlmClient(SMALL_CATALOG);
    // No semantic mapping -> model returns null pick.
    const input: MatchInput = {
      invoiceId: "inv-m3",
      sponsorId: 1,
      studyId: 11,
      lineItems: [line("Courier shipping fee", { unitPrice: 30, amount: 30, quantity: 1 })],
    };
    const out = await matchStage(input, deps(llm, mcp));

    expect(out.items[0].outcome).toBe("unmatched");
    expect(out.items[0].matchedItemId).toBeNull();
  });

  it("marks every line unmatched when the resolved scope is missing (NFR4, no throw)", async () => {
    const mcp = new MockMcpClient(SMALL_CATALOG);
    const llm = new MockLlmClient(SMALL_CATALOG);
    const input: MatchInput = {
      invoiceId: "inv-m4",
      // sponsorId/studyId intentionally omitted
      lineItems: [line("Screening visit"), line("CBC")],
    };
    const out = await matchStage(input, deps(llm, mcp));

    expect(out.items).toHaveLength(2);
    expect(out.items.every((i) => i.outcome === "unmatched")).toBe(true);
    expect(out.catalogSize).toBe(0);
    // No catalog fetch attempted.
    expect(mcp.searchCalls).toHaveLength(0);
  });

  it("runs the lexical shortlist path on a catalog > 50 items without error", async () => {
    // 60 filler items + the real screening-visit target at id 999.
    const big: CatalogItem[] = [];
    for (let i = 0; i < 60; i++) {
      big.push({
        id: 200 + i,
        sponsorId: 1,
        studyId: 11,
        itemCode: `FILL-${i}`,
        description: `Filler procedure number ${i}`,
        unitPrice: 10 + i,
      });
    }
    big.push({ id: 999, sponsorId: 1, studyId: 11, itemCode: "PV-001", description: "Screening visit", unitPrice: 500 });

    const mcp = new MockMcpClient(big);
    const llm = new MockLlmClient(big);
    llm.semanticMap = { "screening visit": 999 };

    const input: MatchInput = {
      invoiceId: "inv-m5",
      sponsorId: 1,
      studyId: 11,
      lineItems: [line("Screening visit", { unitPrice: 500, amount: 500, quantity: 1 })],
    };
    const out = await matchStage(input, deps(llm, mcp));

    expect(out.catalogSize).toBe(61);
    // The shortlist surfaced the lexical "Screening visit" target, and the model picked it.
    expect(out.items[0].matchedItemId).toBe(999);
    expect(out.items[0].outcome).toBe("matched_high");
    // Shortlist bounded the prompt: fewer candidates than the full catalog.
    expect((out.items[0].candidates?.length ?? 0)).toBeLessThanOrEqual(12);
  });
});
