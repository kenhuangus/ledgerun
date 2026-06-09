/**
 * Resolve stage unit tests (FR3).
 *
 * Drives the REAL resolveStage against a mock LlmClient (runToolLoop) + a
 * MockMcpClient. Covers:
 *   - a clean unique resolution           -> resolved_high
 *   - protocol number overriding a wrong sponsor name -> resolved_corrected
 *   - an ambiguous / unresolved case
 *   - the deterministic no-context-signal short-circuit (unresolved, no loop)
 *   - the tool-loop-failure carry path (unresolved, never throws)
 *
 * Asserts resolved ids + ResolutionStatus + evidence (candidates, deciding
 * signal, corrections, recorded tool calls).
 *
 * OFFLINE: no network, no DB.
 */

import { describe, it, expect } from "vitest";
import { resolveStage } from "@/pipeline/resolve";
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
  ResolveInput,
  InvoiceMetadata,
} from "@/contracts";

const MODEL_INFO: ModelInfo = {
  model: "mock-claude",
  promptVersion: "resolve-mock",
  inputTokens: 200,
  outputTokens: 60,
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

/** A MockMcpClient that records calls and returns a small reference universe. */
class MockMcpClient implements McpClient {
  sponsorCalls: Array<string | undefined> = [];
  studyCalls: unknown[] = [];

  async listSponsors(query?: string): Promise<Sponsor[]> {
    this.sponsorCalls.push(query);
    return [
      { id: 1, name: "Northwind Pharma", code: "NW" },
      { id: 2, name: "Contoso Therapeutics", code: "CON" },
    ];
  }
  async listStudies(input?: { sponsorId?: number; query?: string }): Promise<Study[]> {
    this.studyCalls.push(input);
    return [{ id: 11, sponsorId: 1, name: "LUMIN-2024", protocolNumber: "NW-LUM-2024" }];
  }
  async listSites(): Promise<Site[]> {
    return [{ id: 51, name: "Site 51" }];
  }
  async listStudySites(): Promise<StudySite[]> {
    return [{ id: 71, studyId: 11, siteId: 51 }];
  }
  async searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>> {
    return { items: [], total: 0, page: 1, pageSize: input.pageSize ?? 200, pages: 1 };
  }
  async health() {
    return { ok: true, status: "ok" };
  }
}

/**
 * Mock LLM. runToolLoop optionally invokes onToolCall (to exercise the MCP
 * dispatch + evidence trail) then returns the canned final value. If `failLoop`
 * is set it throws to drive the carry-as-unresolved path.
 */
class MockLlmClient implements LlmClient {
  finalValue: unknown = {};
  /** When set, runToolLoop calls each of these tools before returning. */
  toolCallsToMake: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  failLoop = false;

  async completeStructured<T>(
    _input: CompleteStructuredInput<T>,
  ): Promise<CompleteStructuredResult<T>> {
    throw new Error("completeStructured not used in resolve tests");
  }

  async runToolLoop<T>(input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>> {
    if (this.failLoop) throw new Error("LLM tool loop hard failure");
    for (const c of this.toolCallsToMake) {
      await input.onToolCall(c);
    }
    return {
      value: this.finalValue as T,
      transcript: [],
      toolCalls: [],
      modelInfo: MODEL_INFO,
    };
  }
}

function deps(llm: LlmClient, mcp: McpClient): StageDeps {
  return { llm, mcp, policy: DEFAULT_POLICY, logger: noopLogger };
}

function pv(value: string, confidence = 0.95) {
  return { value, confidence };
}

describe("resolveStage (FR3)", () => {
  it("clean unique resolution -> resolved_high with ids + evidence", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    // Make a real tool call so the evidence trail records it.
    llm.toolCallsToMake = [
      { id: "t1", name: "list_studies", input: { query: "NW-LUM-2024" } },
    ];
    llm.finalValue = {
      sponsorId: 1,
      studyId: 11,
      siteId: 51,
      studySiteId: 71,
      status: "resolved_high",
      confidence: 0.97,
      candidates: [
        { kind: "study", refId: 11, label: "LUMIN-2024", matchedOn: "protocol_number", score: 1 },
      ],
      decidingSignal: "protocol_number",
    };

    const md: InvoiceMetadata = {
      sponsorName: pv("Northwind Pharma"),
      protocolNumber: pv("NW-LUM-2024"),
    };
    const input: ResolveInput = { invoiceId: "inv-r1", metadata: md };

    const out = await resolveStage(input, deps(llm, mcp));

    expect(out.status).toBe("resolved_high");
    expect(out.sponsorId).toBe(1);
    expect(out.studyId).toBe(11);
    expect(out.siteId).toBe(51);
    expect(out.studySiteId).toBe(71);
    expect(out.confidence).toBeCloseTo(0.97);
    expect(out.evidence.decidingSignal).toBe("protocol_number");
    expect(out.evidence.candidates).toHaveLength(1);
    // The tool call we made was recorded into the evidence trail + dispatched to MCP.
    expect(out.evidence.toolCalls).toEqual([
      { name: "list_studies", input: { query: "NW-LUM-2024" } },
    ]);
    expect(mcp.studyCalls).toHaveLength(1);
    expect(out.modelInfo).toEqual(MODEL_INFO);
  });

  it("protocol number wins over a wrong sponsor name -> resolved_corrected", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    llm.finalValue = {
      sponsorId: 1,
      studyId: 11,
      status: "resolved_corrected",
      confidence: 0.9,
      candidates: [],
      decidingSignal: "protocol_number",
      corrections: [
        {
          field: "sponsorName",
          statedValue: "Northwest Pharma",
          resolvedValue: "Northwind Pharma",
          note: "stated sponsor overridden by protocol number",
        },
      ],
    };

    const md: InvoiceMetadata = {
      sponsorName: pv("Northwest Pharma"), // WRONG
      protocolNumber: pv("NW-LUM-2024"), // resolves to Northwind
    };
    const out = await resolveStage({ invoiceId: "inv-r2", metadata: md }, deps(llm, mcp));

    expect(out.status).toBe("resolved_corrected");
    expect(out.sponsorId).toBe(1);
    expect(out.evidence.corrections).toHaveLength(1);
    expect(out.evidence.corrections?.[0].field).toBe("sponsorName");
    expect(out.evidence.corrections?.[0].resolvedValue).toBe("Northwind Pharma");
  });

  it("multiple plausible candidates -> ambiguous (ids may be absent)", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    llm.finalValue = {
      sponsorId: null,
      studyId: null,
      status: "ambiguous",
      confidence: 0.4,
      candidates: [
        { kind: "sponsor", refId: 1, label: "Northwind Pharma", matchedOn: "sponsor_name", score: 0.6 },
        { kind: "sponsor", refId: 2, label: "Contoso Therapeutics", matchedOn: "sponsor_name", score: 0.55 },
      ],
    };

    const md: InvoiceMetadata = { sponsorName: pv("North") };
    const out = await resolveStage({ invoiceId: "inv-r3", metadata: md }, deps(llm, mcp));

    expect(out.status).toBe("ambiguous");
    expect(out.sponsorId).toBeUndefined();
    expect(out.studyId).toBeUndefined();
    expect(out.evidence.candidates).toHaveLength(2);
  });

  it("no usable context metadata short-circuits to unresolved (no tool loop)", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    // finalValue intentionally something that would be 'resolved' if the loop ran.
    llm.finalValue = { status: "resolved_high", confidence: 1 };

    const out = await resolveStage({ invoiceId: "inv-r4", metadata: {} }, deps(llm, mcp));

    expect(out.status).toBe("unresolved");
    expect(out.confidence).toBe(0);
    expect(out.evidence.candidates).toEqual([]);
    // The loop never ran -> no MCP traffic.
    expect(mcp.studyCalls).toHaveLength(0);
    expect(mcp.sponsorCalls).toHaveLength(0);
  });

  it("a hard tool-loop failure is carried as unresolved, not thrown (NFR4)", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    llm.failLoop = true;

    const md: InvoiceMetadata = { protocolNumber: pv("NW-LUM-2024") };
    const out = await resolveStage({ invoiceId: "inv-r5", metadata: md }, deps(llm, mcp));

    expect(out.status).toBe("unresolved");
    expect(out.confidence).toBe(0);
    expect(out.evidence.candidates).toEqual([]);
  });

  it("dispatches list_sponsors tool calls through to the MCP client", async () => {
    const mcp = new MockMcpClient();
    const llm = new MockLlmClient();
    llm.toolCallsToMake = [
      { id: "s1", name: "list_sponsors", input: { query: "Northwind" } },
    ];
    llm.finalValue = { status: "unresolved", confidence: 0.2, candidates: [] };

    const md: InvoiceMetadata = { sponsorName: pv("Northwind") };
    await resolveStage({ invoiceId: "inv-r6", metadata: md }, deps(llm, mcp));

    expect(mcp.sponsorCalls).toEqual(["Northwind"]);
  });
});
