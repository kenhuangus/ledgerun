/**
 * QC flow tests (FR7) — DefaultInvoiceService.applyQcAction.
 *
 * Drives the REAL DefaultInvoiceService over an in-memory InvoiceRepo + a stub
 * orchestrator that records its run() calls. Covers each QcAction type:
 *   - review            -> records a QcAction, no rerun
 *   - correct_metadata  -> merges metadata overrides, reruns from "resolve"
 *   - correct_match     -> re-points a line item, reruns from "decide"
 *   - override_decision -> flips the verdict + records the override, no rerun
 *   - rerun             -> re-enters the pipeline from the requested stage
 *
 * Asserts a QcAction row is recorded for every action and the right downstream
 * effect happens (rerun stage / persisted correction / overridden verdict).
 *
 * OFFLINE: no network, no DB (PrismaInvoiceRepo is replaced by a fake).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DefaultInvoiceService } from "@/services/invoiceService";
import type { Orchestrator, RunOptions } from "@/pipeline/orchestrator";
import type {
  InvoiceRepo,
} from "@/repo/invoiceRepo";
import type {
  InvoiceState,
  RawInvoice,
  ExtractOutput,
  ResolveOutput,
  MatchOutput,
  MatchedLineItem,
  DecisionRecord,
  StageEvent,
  AppliedQcAction,
  QcAction,
  InvoiceDetail,
  WorkflowState,
  StageName,
  SubmissionPayload,
} from "@/contracts";

/* ------------------------------ fake repo ------------------------------- */

interface Stored {
  id: string;
  fileName: string;
  state: InvoiceState;
  extraction?: ExtractOutput;
  resolution?: ResolveOutput;
  match?: MatchOutput;
  decision?: DecisionRecord;
  qcActions: AppliedQcAction[];
}

class FakeRepo implements InvoiceRepo {
  invoices = new Map<string, Stored>();
  qcSeq = 0;

  seed(inv: Partial<Stored> & { id: string }): void {
    this.invoices.set(inv.id, {
      fileName: "f.pdf",
      state: "HELD",
      qcActions: [],
      ...inv,
    });
  }

  async createFromRaw(raw: RawInvoice): Promise<{ id: string }> {
    const id = `inv-${this.invoices.size + 1}`;
    this.seed({ id, fileName: raw.fileName, state: "RECEIVED" });
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
  async getDetail(invoiceId: string): Promise<InvoiceDetail | null> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) return null;
    return {
      id: inv.id,
      fileName: inv.fileName,
      source: "sample",
      rawUri: "/tmp/none.pdf",
      state: inv.state,
      receivedAt: new Date().toISOString(),
      metadata: inv.extraction?.extracted.metadata,
      extraction: inv.extraction,
      resolution: inv.resolution,
      match: inv.match,
      lineItems: inv.match?.items ?? [],
      decision: inv.decision,
      events: [] as StageEvent[],
      qcActions: inv.qcActions,
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
  async appendStageEvent(): Promise<void> {
    /* noop */
  }
  async ensureRun(invoiceId: string): Promise<{ runId: string }> {
    return { runId: `run-${invoiceId}` };
  }
  async recordQcAction(invoiceId: string, action: QcAction, actor: string): Promise<AppliedQcAction> {
    const applied: AppliedQcAction = {
      id: `qc-${++this.qcSeq}`,
      actor,
      type: action.type,
      after: action,
      note: "note" in action ? action.note : undefined,
      createdAt: new Date().toISOString(),
    };
    this.get(invoiceId).qcActions.push(applied);
    return applied;
  }
  async saveSubmission(): Promise<void> {
    /* noop */
  }

  private get(id: string): Stored {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`FakeRepo: invoice not found: ${id}`);
    return inv;
  }
}

/* -------------------------- stub orchestrator --------------------------- */

class StubOrchestrator implements Orchestrator {
  runs: Array<{ invoiceId: string; options?: RunOptions }> = [];
  repo: FakeRepo;
  /** State to report after a run. */
  resultState: InvoiceState = "HELD";

  constructor(repo: FakeRepo) {
    this.repo = repo;
  }

  async run(invoiceId: string, options?: RunOptions): Promise<WorkflowState> {
    this.runs.push({ invoiceId, options });
    const inv = await this.repo.getDetail(invoiceId);
    return {
      invoiceId,
      runId: `run-${invoiceId}`,
      state: this.resultState,
      events: [],
      decision: inv?.decision,
    };
  }
}

/* -------------------------------- builders ------------------------------ */

function matchedLine(index: number, overrides: Partial<MatchedLineItem> = {}): MatchedLineItem {
  return {
    index,
    rawDescription: `Line ${index}`,
    quantity: 1,
    unitPrice: 100,
    amount: 100,
    confidence: 0.95,
    matchedItemId: 500 + index,
    outcome: "matched_high",
    matchConfidence: 0.95,
    ...overrides,
  };
}

function seedFullInvoice(repo: FakeRepo, id: string): void {
  repo.seed({
    id,
    state: "HELD",
    extraction: {
      extracted: {
        metadata: { sponsorName: { value: "Old Sponsor", confidence: 0.6 } },
        lineItems: [{ rawDescription: "Line 0", confidence: 0.9 }],
      },
      confidence: 0.9,
      modelInfo: { model: "m", promptVersion: "v" },
    },
    resolution: {
      sponsorId: 1,
      studyId: 11,
      status: "resolved_high",
      confidence: 0.9,
      evidence: { candidates: [], toolCalls: [] },
    },
    match: {
      items: [matchedLine(0, { outcome: "unmatched", matchedItemId: null })],
      catalogSize: 5,
    },
    decision: {
      verdict: "HOLD",
      reasons: [{ code: "line_item_unmatched", message: "held" }],
      policyVersion: "policy-v1",
    },
  });
}

function buildService() {
  const repo = new FakeRepo();
  const orchestrator = new StubOrchestrator(repo);
  const service = new DefaultInvoiceService(repo, orchestrator);
  return { repo, orchestrator, service };
}

describe("DefaultInvoiceService.applyQcAction (FR7)", () => {
  let h: ReturnType<typeof buildService>;

  beforeEach(() => {
    h = buildService();
  });

  it("review records a QcAction and does NOT rerun", async () => {
    seedFullInvoice(h.repo, "inv-1");
    const res = await h.service.applyQcAction("inv-1", { type: "review", note: "looks ok" });

    expect(res.action.type).toBe("review");
    expect(h.repo.invoices.get("inv-1")!.qcActions).toHaveLength(1);
    expect(h.orchestrator.runs).toHaveLength(0); // no rerun
    expect(res.state).toBe("HELD");
  });

  it("correct_metadata merges overrides then reruns from 'resolve'", async () => {
    seedFullInvoice(h.repo, "inv-2");

    const res = await h.service.applyQcAction("inv-2", {
      type: "correct_metadata",
      metadata: { sponsorName: { value: "Corrected Sponsor", confidence: 1 } },
      note: "fixed sponsor",
    });

    // QcAction recorded.
    expect(res.action.type).toBe("correct_metadata");
    expect(h.repo.invoices.get("inv-2")!.qcActions).toHaveLength(1);

    // Metadata override merged into the stored extraction.
    const merged = h.repo.invoices.get("inv-2")!.extraction!.extracted.metadata;
    expect(merged.sponsorName?.value).toBe("Corrected Sponsor");

    // Rerun entered from the resolve stage.
    expect(h.orchestrator.runs).toHaveLength(1);
    expect(h.orchestrator.runs[0].options?.fromStage).toBe<StageName>("resolve");
  });

  it("correct_metadata with id confirmations pins resolution ids", async () => {
    seedFullInvoice(h.repo, "inv-2b");

    await h.service.applyQcAction("inv-2b", {
      type: "correct_metadata",
      sponsorId: 99,
      studyId: 88,
    });

    const resolution = h.repo.invoices.get("inv-2b")!.resolution!;
    expect(resolution.sponsorId).toBe(99);
    expect(resolution.studyId).toBe(88);
    expect(resolution.status).toBe("resolved_corrected");
  });

  it("correct_match re-points a line item then reruns from 'decide'", async () => {
    seedFullInvoice(h.repo, "inv-3");

    const res = await h.service.applyQcAction("inv-3", {
      type: "correct_match",
      lineItemIndex: 0,
      matchedItemId: 777,
      note: "manual re-point",
    });

    expect(res.action.type).toBe("correct_match");
    expect(h.repo.invoices.get("inv-3")!.qcActions).toHaveLength(1);

    // The line was re-pointed and promoted to matched_high.
    const item = h.repo.invoices.get("inv-3")!.match!.items[0];
    expect(item.matchedItemId).toBe(777);
    expect(item.outcome).toBe("matched_high");
    expect(item.rationale).toBe("manual re-point");

    // Re-decide only.
    expect(h.orchestrator.runs).toHaveLength(1);
    expect(h.orchestrator.runs[0].options?.fromStage).toBe<StageName>("decide");
  });

  it("correct_match with matchedItemId null marks the line unmatched", async () => {
    seedFullInvoice(h.repo, "inv-3b");

    await h.service.applyQcAction("inv-3b", {
      type: "correct_match",
      lineItemIndex: 0,
      matchedItemId: null,
    });

    const item = h.repo.invoices.get("inv-3b")!.match!.items[0];
    expect(item.matchedItemId).toBeNull();
    expect(item.outcome).toBe("unmatched");
  });

  it("override_decision flips the verdict, records it, and does NOT rerun", async () => {
    seedFullInvoice(h.repo, "inv-4");

    const res = await h.service.applyQcAction("inv-4", {
      type: "override_decision",
      verdict: "SUBMIT",
      note: "manually cleared by QC",
    });

    expect(res.action.type).toBe("override_decision");
    expect(h.repo.invoices.get("inv-4")!.qcActions).toHaveLength(1);

    // Decision flipped to SUBMIT with an override reason carrying the prior verdict.
    const decision = h.repo.invoices.get("inv-4")!.decision!;
    expect(decision.verdict).toBe("SUBMIT");
    expect(decision.reasons[0].evidence?.override).toBe(true);
    expect(decision.reasons[0].evidence?.priorVerdict).toBe("HOLD");

    // State moved to SUBMITTED, no pipeline rerun.
    expect(res.state).toBe("SUBMITTED");
    expect(h.repo.invoices.get("inv-4")!.state).toBe("SUBMITTED");
    expect(h.orchestrator.runs).toHaveLength(0);
  });

  it("override_decision to HOLD parks the invoice as HELD", async () => {
    seedFullInvoice(h.repo, "inv-4b");
    h.repo.invoices.get("inv-4b")!.decision!.verdict = "SUBMIT";

    const res = await h.service.applyQcAction("inv-4b", {
      type: "override_decision",
      verdict: "HOLD",
    });

    expect(res.state).toBe("HELD");
    expect(h.repo.invoices.get("inv-4b")!.decision!.verdict).toBe("HOLD");
  });

  it("rerun re-enters the pipeline from the requested stage", async () => {
    seedFullInvoice(h.repo, "inv-5");
    h.orchestrator.resultState = "SUBMITTED";

    const res = await h.service.applyQcAction("inv-5", {
      type: "rerun",
      fromStage: "match",
    });

    expect(res.action.type).toBe("rerun");
    expect(h.repo.invoices.get("inv-5")!.qcActions).toHaveLength(1);
    expect(h.orchestrator.runs).toHaveLength(1);
    expect(h.orchestrator.runs[0].options?.fromStage).toBe<StageName>("match");
    expect(res.state).toBe("SUBMITTED");
  });
});
