/**
 * Integration test — the REAL orchestrator + REAL stage impls (extract, resolve,
 * match, decide) + REAL deterministic decide policy, driven against deterministic
 * MockLlmClient / MockMcpClient and an in-memory repo. NO network, NO DB.
 *
 * Asserts the prd.md §9 acceptance behavior for all four sample invoices:
 *   - simple            -> SUBMIT, no exceptions
 *   - medium            -> HOLD on a price_mismatch
 *   - large             -> HOLD with unmatched + ambiguous + price_mismatch
 *   - mismatched-metadata -> resolved_corrected -> HOLD pending confirmation
 *
 * The mocks return canned, schema-faithful data keyed off the invoice's fileName.
 * This is the offline proof the wiring is correct end to end: orchestrator ->
 * stages -> LLM/MCP seams -> decide policy -> verdict.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createOrchestrator } from "@/pipeline/orchestrator";
import { extractStage } from "@/pipeline/extract";
import { resolveStage } from "@/pipeline/resolve";
import { matchStage } from "@/pipeline/match";
import { decideStage } from "@/pipeline/decide";
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
  ModelInfo,
  Logger,
  ClinRunClient,
  SubmissionPayload,
  SubmissionResult,
  InvoiceState,
  ExtractOutput,
  ResolveOutput,
  MatchOutput,
  DecisionRecord,
  StageEvent,
} from "@/contracts";
import type { InvoiceRepo } from "@/repo/invoiceRepo";
import type { RawInvoice } from "@/contracts";

/* ----------------------------- scenario data ---------------------------- */

type Scenario = "simple" | "medium" | "large" | "mismatched";

const MODEL_INFO: ModelInfo = {
  model: "mock-claude",
  promptVersion: "mock-v1",
  inputTokens: 100,
  outputTokens: 50,
};

/** Canned catalog per scenario. ids are numeric RefIds (reference-API style). */
const CATALOGS: Record<Scenario, CatalogItem[]> = {
  simple: [
    { id: 101, sponsorId: 1, studyId: 11, itemCode: "PV-001", description: "Screening visit", unitPrice: 500 },
    { id: 102, sponsorId: 1, studyId: 11, itemCode: "PV-002", description: "Baseline visit", unitPrice: 600 },
    { id: 103, sponsorId: 1, studyId: 11, itemCode: "LAB-010", description: "Hematology panel", unitPrice: 120 },
    { id: 104, sponsorId: 1, studyId: 11, itemCode: "LAB-011", description: "Chemistry panel", unitPrice: 140 },
    { id: 105, sponsorId: 1, studyId: 11, itemCode: "PROC-020", description: "ECG twelve lead", unitPrice: 200 },
  ],
  medium: [
    { id: 201, sponsorId: 2, studyId: 22, itemCode: "MV-001", description: "Monthly visit", unitPrice: 700 },
    { id: 202, sponsorId: 2, studyId: 22, itemCode: "INF-002", description: "Infusion administration", unitPrice: 900 },
    { id: 203, sponsorId: 2, studyId: 22, itemCode: "LAB-100", description: "Pharmacokinetic draw", unitPrice: 150 },
  ],
  large: [
    { id: 301, sponsorId: 2, studyId: 22, itemCode: "LV-001", description: "Long visit", unitPrice: 800 },
    { id: 302, sponsorId: 2, studyId: 22, itemCode: "INF-A", description: "Infusion A", unitPrice: 950 },
    { id: 303, sponsorId: 2, studyId: 22, itemCode: "INF-B", description: "Infusion B", unitPrice: 960 },
    { id: 304, sponsorId: 2, studyId: 22, itemCode: "LAB-200", description: "Special assay", unitPrice: 300 },
  ],
  mismatched: [
    { id: 401, sponsorId: 2, studyId: 33, itemCode: "VE-001", description: "Veritas visit", unitPrice: 400 },
    { id: 402, sponsorId: 2, studyId: 33, itemCode: "VE-002", description: "Veritas procedure", unitPrice: 550 },
  ],
};

/** Resolve loop final value per scenario. */
const RESOLVE_RESULTS: Record<Scenario, Record<string, unknown>> = {
  simple: {
    sponsorId: 1,
    studyId: 11,
    siteId: 51,
    studySiteId: 71,
    status: "resolved_high",
    confidence: 0.97,
    candidates: [],
    decidingSignal: "protocol_number",
  },
  medium: {
    sponsorId: 2,
    studyId: 22,
    siteId: 52,
    studySiteId: 72,
    status: "resolved_high",
    confidence: 0.95,
    candidates: [],
    decidingSignal: "protocol_number",
  },
  large: {
    sponsorId: 2,
    studyId: 22,
    siteId: 52,
    studySiteId: 72,
    status: "resolved_high",
    confidence: 0.94,
    candidates: [],
    decidingSignal: "protocol_number",
  },
  mismatched: {
    sponsorId: 2,
    studyId: 33,
    siteId: 53,
    studySiteId: 73,
    status: "resolved_corrected",
    confidence: 0.9,
    candidates: [],
    decidingSignal: "protocol_number",
    corrections: [
      {
        field: "sponsorName",
        statedValue: "Northwest Pharma",
        resolvedValue: "Northwind Pharma",
        note: "stated sponsor name overridden by protocol number",
      },
    ],
  },
};

/**
 * Extract output (metadata + lineItems) per scenario, shaped exactly like the
 * extract JSON schema the real extract stage feeds to completeStructured.
 * unitPrice/amount on lines is what gets billed; matching/decide reconcile it
 * against the catalog unitPrice above.
 */
function pv<T>(value: T) {
  return { value, confidence: 0.95 };
}

const EXTRACTS: Record<Scenario, Record<string, unknown>> = {
  simple: {
    metadata: {
      sponsorName: pv("Contoso Therapeutics"),
      studyName: pv("CATALYST Trial"),
      protocolNumber: pv("CON-CAT-2024-101"),
      total: pv(1560),
    },
    lineItems: [
      { rawDescription: "Screening visit", quantity: 1, unitPrice: 500, amount: 500, confidence: 0.95 },
      { rawDescription: "Baseline visit", quantity: 1, unitPrice: 600, amount: 600, confidence: 0.95 },
      { rawDescription: "Hematology panel", quantity: 1, unitPrice: 120, amount: 120, confidence: 0.95 },
      { rawDescription: "Chemistry panel", quantity: 1, unitPrice: 140, amount: 140, confidence: 0.95 },
      { rawDescription: "ECG twelve lead", quantity: 1, unitPrice: 200, amount: 200, confidence: 0.95 },
    ],
    overallConfidence: 0.95,
  },
  medium: {
    metadata: {
      sponsorName: pv("Northwind Pharma"),
      studyName: pv("LUMIN-2024"),
      protocolNumber: pv("NW-LUM-2024"),
      total: pv(2050),
    },
    lineItems: [
      { rawDescription: "Monthly visit", quantity: 1, unitPrice: 700, amount: 700, confidence: 0.95 },
      // Infusion administration billed at 1200 vs catalog 900 -> price_mismatch.
      { rawDescription: "Infusion administration", quantity: 1, unitPrice: 1200, amount: 1200, confidence: 0.95 },
      { rawDescription: "Pharmacokinetic draw", quantity: 1, unitPrice: 150, amount: 150, confidence: 0.95 },
    ],
    overallConfidence: 0.95,
  },
  large: {
    metadata: {
      sponsorName: pv("Northwind Pharma"),
      studyName: pv("LUMIN-2024"),
      protocolNumber: pv("NW-LUM-2024"),
      total: pv(5000),
    },
    lineItems: [
      { rawDescription: "Long visit", quantity: 1, unitPrice: 800, amount: 800, confidence: 0.95 },
      // Infusion A billed at 1500 vs catalog 950 -> price_mismatch.
      { rawDescription: "Infusion A", quantity: 1, unitPrice: 1500, amount: 1500, confidence: 0.95 },
      // Infusion (ambiguous between Infusion A and Infusion B).
      { rawDescription: "Infusion", quantity: 1, unitPrice: 950, amount: 950, confidence: 0.95 },
      // Three lines with no catalog match -> unmatched.
      { rawDescription: "Courier shipping fee", quantity: 1, unitPrice: 50, amount: 50, confidence: 0.95 },
      { rawDescription: "Storage surcharge", quantity: 1, unitPrice: 75, amount: 75, confidence: 0.95 },
      { rawDescription: "Miscellaneous handling", quantity: 1, unitPrice: 60, amount: 60, confidence: 0.95 },
    ],
    overallConfidence: 0.94,
  },
  mismatched: {
    metadata: {
      // Stated sponsor name is WRONG; protocol number resolves correctly.
      sponsorName: pv("Northwest Pharma"),
      studyName: pv("VERITAS"),
      protocolNumber: pv("NW-VER-2024"),
      total: pv(950),
    },
    lineItems: [
      { rawDescription: "Veritas visit", quantity: 1, unitPrice: 400, amount: 400, confidence: 0.95 },
      { rawDescription: "Veritas procedure", quantity: 1, unitPrice: 550, amount: 550, confidence: 0.95 },
    ],
    overallConfidence: 0.9,
  },
};

/* ----------------------------- mock LLM --------------------------------- */

/**
 * Routes completeStructured to extract vs match by schema shape, and runToolLoop
 * for resolve. Keyed off the active scenario (set per-invoice by the test).
 */
class MockLlmClient implements LlmClient {
  scenario: Scenario = "simple";

  async completeStructured<T>(input: CompleteStructuredInput<T>): Promise<CompleteStructuredResult<T>> {
    const props = (input.schema?.properties ?? {}) as Record<string, unknown>;
    // Extract schema has metadata + lineItems; match (pick) schema has catalogItemId.
    if ("metadata" in props && "lineItems" in props) {
      return { value: EXTRACTS[this.scenario] as T, modelInfo: MODEL_INFO };
    }
    if ("catalogItemId" in props) {
      const pick = this.pickForLine(input);
      return { value: pick as T, modelInfo: MODEL_INFO };
    }
    throw new Error("MockLlmClient: unrecognized structured schema");
  }

  /** Deterministic per-line pick derived from the candidate list in the prompt. */
  private pickForLine<T>(input: CompleteStructuredInput<T>): Record<string, unknown> {
    const userMsg = input.messages.map((m) => m.content).join("\n");
    const lineDesc = (/Description:\s*"([^"]*)"/.exec(userMsg)?.[1] ?? "").toLowerCase();
    const catalog = CATALOGS[this.scenario];

    // Parse the candidate ids the prompt offered (id=NNN).
    const candIds = Array.from(userMsg.matchAll(/id=(\d+)/g)).map((m) => Number(m[1]));
    const cands = catalog.filter((c) => candIds.includes(c.id));

    // Ambiguous line: "infusion" alone, with both Infusion A/B in shortlist.
    if (this.scenario === "large" && lineDesc === "infusion") {
      const a = cands.find((c) => c.itemCode === "INF-A");
      const b = cands.find((c) => c.itemCode === "INF-B");
      if (a && b) {
        return {
          catalogItemId: a.id,
          confidence: 0.82,
          rationale: "Could be Infusion A or Infusion B.",
          alternates: [{ catalogItemId: b.id, confidence: 0.8 }],
        };
      }
    }

    // Otherwise pick the catalog item whose description matches the line desc.
    const exact = cands.find((c) => c.description.toLowerCase() === lineDesc);
    if (exact) {
      return {
        catalogItemId: exact.id,
        confidence: 0.95,
        rationale: `Matches catalog item ${exact.itemCode}.`,
        alternates: [],
      };
    }
    // No genuine match -> unmatched (null pick).
    return {
      catalogItemId: null,
      confidence: 0.1,
      rationale: "No catalog candidate matches this line.",
      alternates: [],
    };
  }

  async runToolLoop<T>(input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>> {
    // The real resolve stage gives us a finalSchema; we return the canned final
    // value for the active scenario. We don't need to invoke onToolCall, but do
    // one harmless call so the evidence trail is realistic.
    void input;
    return {
      value: RESOLVE_RESULTS[this.scenario] as T,
      transcript: [],
      toolCalls: [],
      modelInfo: MODEL_INFO,
    };
  }
}

/* ----------------------------- mock MCP --------------------------------- */

class MockMcpClient implements McpClient {
  scenario: Scenario = "simple";

  async listSponsors(): Promise<Sponsor[]> {
    return [{ id: 1, name: "Contoso Therapeutics", code: "CON" }, { id: 2, name: "Northwind Pharma", code: "NW" }];
  }
  async listStudies(): Promise<Study[]> {
    return [
      { id: 11, sponsorId: 1, name: "CATALYST Trial", protocolNumber: "CON-CAT-2024-101" },
      { id: 22, sponsorId: 2, name: "LUMIN-2024", protocolNumber: "NW-LUM-2024" },
      { id: 33, sponsorId: 2, name: "VERITAS", protocolNumber: "NW-VER-2024" },
    ];
  }
  async listSites(): Promise<Site[]> {
    return [{ id: 51, name: "Site 51" }, { id: 52, name: "Site 52" }, { id: 53, name: "Site 53" }];
  }
  async listStudySites(): Promise<StudySite[]> {
    return [{ id: 71, studyId: 11, siteId: 51 }];
  }
  async searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>> {
    const items = CATALOGS[this.scenario];
    return { items, total: items.length, page: 1, pageSize: input.pageSize ?? 200, pages: 1 };
  }
  async health() {
    return { ok: true, status: "ok" };
  }
}

/* ----------------------------- in-memory repo --------------------------- */

interface StoredInvoice {
  id: string;
  fileName: string;
  state: InvoiceState;
  extraction?: ExtractOutput;
  resolution?: ResolveOutput;
  match?: MatchOutput;
  decision?: DecisionRecord;
  runId?: string;
  events: StageEvent[];
  submission?: { payload: SubmissionPayload; externalRef: string };
}

class MemRepo implements InvoiceRepo {
  invoices = new Map<string, StoredInvoice>();
  private seq = 0;

  seed(id: string, fileName: string): void {
    this.invoices.set(id, { id, fileName, state: "RECEIVED", events: [] });
  }

  async createFromRaw(raw: RawInvoice, _rawUri: string): Promise<{ id: string }> {
    const id = `inv-${++this.seq}`;
    this.invoices.set(id, { id, fileName: raw.fileName, state: "RECEIVED", events: [] });
    return { id };
  }
  async setState(invoiceId: string, state: InvoiceState): Promise<void> {
    this.get(invoiceId).state = state;
  }
  async getState(invoiceId: string): Promise<InvoiceState | null> {
    return this.invoices.get(invoiceId)?.state ?? null;
  }
  async list() {
    return [];
  }
  async getDetail(invoiceId: string) {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    return {
      id: inv.id,
      fileName: inv.fileName,
      source: "sample" as const,
      rawUri: "",
      state: inv.state,
      receivedAt: new Date().toISOString(),
      metadata: inv.extraction?.extracted.metadata,
      extraction: inv.extraction,
      resolution: inv.resolution,
      match: inv.match,
      lineItems: inv.match?.items ?? [],
      decision: inv.decision,
      events: inv.events,
      qcActions: [],
    };
  }
  async saveExtraction(invoiceId: string, out: ExtractOutput): Promise<void> {
    this.get(invoiceId).extraction = out;
  }
  async saveResolution(invoiceId: string, out: ResolveOutput): Promise<void> {
    this.get(invoiceId).resolution = out;
  }
  async saveMatch(invoiceId: string, out: MatchOutput): Promise<void> {
    this.get(invoiceId).match = out;
  }
  async saveDecision(invoiceId: string, decision: DecisionRecord): Promise<void> {
    this.get(invoiceId).decision = decision;
  }
  async appendStageEvent(runId: string, event: StageEvent): Promise<void> {
    for (const inv of this.invoices.values()) {
      if (inv.runId === runId) {
        inv.events.push(event);
        return;
      }
    }
  }
  async ensureRun(invoiceId: string): Promise<{ runId: string }> {
    const inv = this.get(invoiceId);
    inv.runId = inv.runId ?? `run-${invoiceId}`;
    return { runId: inv.runId };
  }
  async recordQcAction(): Promise<never> {
    throw new Error("not used in integration test");
  }
  async saveSubmission(invoiceId: string, payload: SubmissionPayload, externalRef: string): Promise<void> {
    this.get(invoiceId).submission = { payload, externalRef };
  }

  private get(id: string): StoredInvoice {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`MemRepo: invoice not found: ${id}`);
    return inv;
  }
}

/* --------------------------- mock collaborators ------------------------- */

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

class MockClinRun implements ClinRunClient {
  submitted: SubmissionPayload[] = [];
  async submit(payload: SubmissionPayload): Promise<SubmissionResult> {
    this.submitted.push(payload);
    return { externalRef: `CR-${payload.invoiceId}` };
  }
}

/* ------------------------------- harness -------------------------------- */

function buildHarness() {
  const repo = new MemRepo();
  const llm = new MockLlmClient();
  const mcp = new MockMcpClient();
  const clinRun = new MockClinRun();

  const deps = {
    llm,
    mcp,
    policy: DEFAULT_POLICY,
    logger: noopLogger,
    repo,
    clinRun,
    loadDocument: async (invoiceId: string) => {
      const inv = await repo.getDetail(invoiceId);
      return { documentText: "mock document text layer", fileName: inv?.fileName ?? "" };
    },
  };

  const orchestrator = createOrchestrator(
    { extract: extractStage, resolve: resolveStage, match: matchStage, decide: decideStage },
    deps,
  );

  return { repo, llm, mcp, clinRun, orchestrator };
}

const FILES: Record<Scenario, string> = {
  simple: "simple-invoice.pdf",
  medium: "medium-invoice.pdf",
  large: "large-invoice.pdf",
  mismatched: "mismatched-metadata-invoice.pdf",
};

/* -------------------------------- tests --------------------------------- */

describe("pipeline integration (real orchestrator + stages + decide, mocked LLM/MCP)", () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    h = buildHarness();
  });

  async function runScenario(scenario: Scenario) {
    h.llm.scenario = scenario;
    h.mcp.scenario = scenario;
    const id = `inv-${scenario}`;
    h.repo.seed(id, FILES[scenario]);
    const state = await h.orchestrator.run(id);
    return state;
  }

  it("simple -> SUBMIT with no exceptions", async () => {
    const state = await runScenario("simple");
    expect(state.state).toBe("SUBMITTED");
    expect(state.decision?.verdict).toBe("SUBMIT");
    expect(state.resolution?.status).toBe("resolved_high");
    const outcomes = state.match?.items.map((i) => i.outcome) ?? [];
    expect(outcomes.every((o) => o === "matched_high")).toBe(true);
    expect(h.clinRun.submitted).toHaveLength(1);
  });

  it("medium -> HOLD on a price_mismatch", async () => {
    const state = await runScenario("medium");
    expect(state.state).toBe("HELD");
    expect(state.decision?.verdict).toBe("HOLD");
    const codes = state.decision?.reasons.map((r) => r.code) ?? [];
    expect(codes).toContain("line_item_price_mismatch");
    const outcomes = state.match?.items.map((i) => i.outcome) ?? [];
    expect(outcomes).toContain("price_mismatch");
    expect(outcomes.filter((o) => o === "price_mismatch")).toHaveLength(1);
    expect(h.clinRun.submitted).toHaveLength(0);
  });

  it("large -> HOLD with unmatched + ambiguous + price_mismatch", async () => {
    const state = await runScenario("large");
    expect(state.state).toBe("HELD");
    expect(state.decision?.verdict).toBe("HOLD");
    const codes = new Set(state.decision?.reasons.map((r) => r.code) ?? []);
    expect(codes.has("line_item_price_mismatch")).toBe(true);
    expect(codes.has("line_item_unmatched")).toBe(true);
    expect(codes.has("line_item_ambiguous")).toBe(true);
    const outcomes = state.match?.items.map((i) => i.outcome) ?? [];
    expect(outcomes.filter((o) => o === "unmatched").length).toBeGreaterThanOrEqual(3);
    expect(outcomes).toContain("ambiguous");
    expect(outcomes).toContain("price_mismatch");
  });

  it("mismatched-metadata -> resolved_corrected -> HOLD pending confirmation", async () => {
    const state = await runScenario("mismatched");
    expect(state.state).toBe("HELD");
    expect(state.resolution?.status).toBe("resolved_corrected");
    expect(state.resolution?.evidence.corrections?.length).toBeGreaterThan(0);
    expect(state.decision?.verdict).toBe("HOLD");
    const codes = state.decision?.reasons.map((r) => r.code) ?? [];
    expect(codes).toContain("context_corrected_needs_confirmation");
    expect(h.clinRun.submitted).toHaveLength(0);
  });
});
