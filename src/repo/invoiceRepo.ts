/**
 * Invoice repository (data-access layer). Owned by the Service/Repo module.
 * Encapsulates all Prisma reads/writes for invoices, extractions, resolutions,
 * line items, decisions, runs, stage events, submissions, and QC actions. The
 * service layer and orchestrator persist through this, never raw Prisma in
 * business logic.
 *
 * Reference-API ids are integers (RefId = number) but persisted as String? in
 * Prisma — stringify on write, parseInt on read (see contracts/mcp.ts).
 */

import { prisma } from "@/lib/db";
import type {
  InvoiceDetail,
  InvoiceListFilter,
  InvoiceSummary,
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
  QcActionType,
  InvoiceMetadata,
  ModelInfo,
  ResolutionStatus,
  ResolutionEvidence,
  MatchOutcome,
  MatchCandidate,
  RefId,
  Verdict,
  DecisionReason,
  StageName,
  StageStatus,
  SubmissionPayload,
} from "@/contracts";
import { InvoiceState as PrismaInvoiceState } from "@prisma/client";

/* ----------------------------- helpers -------------------------------- */

function toRefId(s: string | null | undefined): RefId | undefined {
  if (s === null || s === undefined || s === "") return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? undefined : n;
}

function fromRefId(id: RefId | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  return String(id);
}

/** Map the string-literal InvoiceState union to the Prisma enum value. */
function toPrismaState(state: InvoiceState): PrismaInvoiceState {
  return PrismaInvoiceState[state];
}

/* ------------------------------ interface ----------------------------- */

export interface InvoiceRepo {
  createFromRaw(raw: RawInvoice, rawUri: string): Promise<{ id: string }>;
  setState(invoiceId: string, state: InvoiceState): Promise<void>;
  list(filter?: InvoiceListFilter): Promise<InvoiceSummary[]>;
  getDetail(invoiceId: string): Promise<InvoiceDetail | null>;
  saveExtraction(invoiceId: string, out: ExtractOutput): Promise<void>;
  saveResolution(invoiceId: string, out: ResolveOutput): Promise<void>;
  saveMatch(invoiceId: string, out: MatchOutput): Promise<void>;
  saveDecision(invoiceId: string, decision: DecisionRecord): Promise<void>;
  appendStageEvent(runId: string, event: StageEvent): Promise<void>;
  ensureRun(invoiceId: string): Promise<{ runId: string }>;
  recordQcAction(invoiceId: string, action: QcAction, actor: string): Promise<AppliedQcAction>;
  /** Persist a Submission record (called on SUBMIT verdict). Extra to the contract. */
  saveSubmission(invoiceId: string, payload: SubmissionPayload, externalRef: string): Promise<void>;
  /** Read the current persisted state (used by the orchestrator/service for reruns). */
  getState(invoiceId: string): Promise<InvoiceState | null>;
}

/* ----------------------------- implementation ------------------------- */

export class PrismaInvoiceRepo implements InvoiceRepo {
  async createFromRaw(raw: RawInvoice, rawUri: string): Promise<{ id: string }> {
    const created = await prisma.invoice.create({
      data: {
        source: raw.source,
        fileName: raw.fileName,
        rawUri,
        state: PrismaInvoiceState.RECEIVED,
      },
      select: { id: true },
    });
    return { id: created.id };
  }

  async setState(invoiceId: string, state: InvoiceState): Promise<void> {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { state: toPrismaState(state) },
    });
  }

  async getState(invoiceId: string): Promise<InvoiceState | null> {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { state: true },
    });
    return inv ? (inv.state as InvoiceState) : null;
  }

  async list(filter?: InvoiceListFilter): Promise<InvoiceSummary[]> {
    const where: Record<string, unknown> = {};

    if (filter?.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state];
      where.state = { in: states.map(toPrismaState) };
    } else if (filter?.lane === "submitted") {
      where.state = PrismaInvoiceState.SUBMITTED;
    } else if (filter?.lane === "held") {
      where.state = PrismaInvoiceState.HELD;
    }

    if (filter?.query) {
      where.fileName = { contains: filter.query, mode: "insensitive" };
    }

    const rows = await prisma.invoice.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: filter?.limit,
      skip: filter?.offset,
      include: {
        decision: { select: { verdict: true } },
        lineItems: { select: { matchOutcome: true } },
      },
    });

    return rows.map((r) => {
      const exceptionCount = r.lineItems.filter((li) =>
        li.matchOutcome
          ? ["matched_low", "ambiguous", "unmatched", "price_mismatch"].includes(li.matchOutcome)
          : false,
      ).length;
      return {
        id: r.id,
        fileName: r.fileName,
        source: r.source,
        state: r.state as InvoiceState,
        receivedAt: r.receivedAt.toISOString(),
        verdict: r.decision?.verdict as Verdict | undefined,
        exceptionCount,
      };
    });
  }

  async getDetail(invoiceId: string): Promise<InvoiceDetail | null> {
    const r = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        extraction: true,
        resolution: true,
        lineItems: { orderBy: { id: "asc" } },
        decision: true,
        qcActions: { orderBy: { createdAt: "asc" } },
        run: { include: { events: { orderBy: { at: "asc" } } } },
      },
    });
    if (!r) return null;

    const metadata = (r.extraction?.metadata as InvoiceMetadata | undefined) ?? undefined;

    const extraction: ExtractOutput | undefined = r.extraction
      ? {
          extracted: {
            metadata: metadata ?? {},
            lineItems: r.lineItems.map((li) => ({
              rawDescription: li.rawDescription,
              quantity: li.quantity ?? undefined,
              unitPrice: li.unitPrice ?? undefined,
              amount: li.amount ?? undefined,
              confidence: 1,
            })),
          },
          confidence: r.extraction.confidence,
          modelInfo: r.extraction.modelInfo as unknown as ModelInfo,
        }
      : undefined;

    const resolution: ResolveOutput | undefined = r.resolution
      ? {
          sponsorId: toRefId(r.resolution.sponsorId),
          studyId: toRefId(r.resolution.studyId),
          siteId: toRefId(r.resolution.siteId),
          studySiteId: toRefId(r.resolution.studySiteId),
          status: r.resolution.status as ResolutionStatus,
          confidence: r.resolution.confidence,
          evidence: r.resolution.evidence as unknown as ResolutionEvidence,
        }
      : undefined;

    const lineItems: MatchedLineItem[] = r.lineItems.map((li, index) => ({
      index,
      rawDescription: li.rawDescription,
      quantity: li.quantity ?? undefined,
      unitPrice: li.unitPrice ?? undefined,
      amount: li.amount ?? undefined,
      confidence: 1,
      matchedItemId: toRefId(li.matchedItemId) ?? null,
      outcome: (li.matchOutcome as MatchOutcome | null) ?? "unmatched",
      matchConfidence: li.matchConfidence ?? undefined,
      rationale: li.rationale ?? undefined,
      candidates: (li.candidates as MatchCandidate[] | null) ?? undefined,
    }));

    const match: MatchOutput | undefined =
      r.lineItems.length > 0
        ? {
            items: lineItems,
            catalogSize: undefined,
          }
        : undefined;

    const decision: DecisionRecord | undefined = r.decision
      ? {
          verdict: r.decision.verdict as Verdict,
          reasons: r.decision.reasons as unknown as DecisionReason[],
          policyVersion: r.decision.policyVer,
        }
      : undefined;

    const events: StageEvent[] =
      r.run?.events.map((e) => ({
        stage: e.stage as StageName,
        status: e.status as StageStatus,
        latencyMs: e.latencyMs ?? undefined,
        tokens: e.tokens ?? undefined,
        inputRef: e.inputRef ?? undefined,
        outputRef: e.outputRef ?? undefined,
        error: e.error ?? undefined,
        at: e.at.toISOString(),
      })) ?? [];

    const qcActions: AppliedQcAction[] = r.qcActions.map((q) => ({
      id: q.id,
      actor: q.actor,
      type: q.type as QcActionType,
      before: q.before ?? undefined,
      after: q.after ?? undefined,
      note: q.note ?? undefined,
      createdAt: q.createdAt.toISOString(),
    }));

    return {
      id: r.id,
      fileName: r.fileName,
      source: r.source,
      rawUri: r.rawUri,
      state: r.state as InvoiceState,
      receivedAt: r.receivedAt.toISOString(),
      metadata,
      extraction,
      resolution,
      match,
      lineItems,
      decision,
      events,
      qcActions,
    };
  }

  async saveExtraction(invoiceId: string, out: ExtractOutput): Promise<void> {
    const metadata = out.extracted.metadata as unknown as object;
    const modelInfo = out.modelInfo as unknown as object;

    await prisma.$transaction([
      prisma.extraction.upsert({
        where: { invoiceId },
        create: {
          invoiceId,
          metadata,
          modelInfo,
          confidence: out.confidence,
        },
        update: {
          metadata,
          modelInfo,
          confidence: out.confidence,
        },
      }),
      // Re-seed line items from the extraction (match will enrich them later).
      prisma.lineItem.deleteMany({ where: { invoiceId } }),
      prisma.lineItem.createMany({
        data: out.extracted.lineItems.map((li) => ({
          invoiceId,
          rawDescription: li.rawDescription,
          quantity: li.quantity ?? null,
          unitPrice: li.unitPrice ?? null,
          amount: li.amount ?? null,
        })),
      }),
    ]);
  }

  async saveResolution(invoiceId: string, out: ResolveOutput): Promise<void> {
    const evidence = out.evidence as unknown as object;
    await prisma.contextResolution.upsert({
      where: { invoiceId },
      create: {
        invoiceId,
        sponsorId: fromRefId(out.sponsorId),
        studyId: fromRefId(out.studyId),
        siteId: fromRefId(out.siteId),
        studySiteId: fromRefId(out.studySiteId),
        status: out.status,
        evidence,
        confidence: out.confidence,
      },
      update: {
        sponsorId: fromRefId(out.sponsorId),
        studyId: fromRefId(out.studyId),
        siteId: fromRefId(out.siteId),
        studySiteId: fromRefId(out.studySiteId),
        status: out.status,
        evidence,
        confidence: out.confidence,
      },
    });
  }

  async saveMatch(invoiceId: string, out: MatchOutput): Promise<void> {
    // Line items already exist (from extraction, ordered by id asc). Update each
    // by stable index → matching the same ordering getDetail uses.
    const existing = await prisma.lineItem.findMany({
      where: { invoiceId },
      orderBy: { id: "asc" },
      select: { id: true },
    });

    const updates = out.items.map((item) => {
      const row = existing[item.index];
      if (!row) return null;
      return prisma.lineItem.update({
        where: { id: row.id },
        data: {
          quantity: item.quantity ?? null,
          unitPrice: item.unitPrice ?? null,
          amount: item.amount ?? null,
          matchedItemId: fromRefId(item.matchedItemId ?? undefined),
          matchOutcome: item.outcome,
          matchConfidence: item.matchConfidence ?? null,
          rationale: item.rationale ?? null,
          candidates: (item.candidates as unknown as object) ?? undefined,
        },
      });
    });

    await prisma.$transaction(updates.filter((u): u is NonNullable<typeof u> => u !== null));
  }

  async saveDecision(invoiceId: string, decision: DecisionRecord): Promise<void> {
    const reasons = decision.reasons as unknown as object;
    await prisma.decision.upsert({
      where: { invoiceId },
      create: {
        invoiceId,
        verdict: decision.verdict,
        reasons,
        policyVer: decision.policyVersion,
      },
      update: {
        verdict: decision.verdict,
        reasons,
        policyVer: decision.policyVersion,
        decidedAt: new Date(),
      },
    });
  }

  async ensureRun(invoiceId: string): Promise<{ runId: string }> {
    const existing = await prisma.workflowRun.findUnique({
      where: { invoiceId },
      select: { id: true },
    });
    if (existing) return { runId: existing.id };
    const created = await prisma.workflowRun.create({
      data: { invoiceId },
      select: { id: true },
    });
    return { runId: created.id };
  }

  async appendStageEvent(runId: string, event: StageEvent): Promise<void> {
    await prisma.stageEvent.create({
      data: {
        runId,
        stage: event.stage,
        status: event.status,
        latencyMs: event.latencyMs ?? null,
        tokens: event.tokens ?? null,
        inputRef: (event.inputRef as object | undefined) ?? undefined,
        outputRef: (event.outputRef as object | undefined) ?? undefined,
        error: event.error ?? null,
        at: event.at ? new Date(event.at) : new Date(),
      },
    });
  }

  async recordQcAction(
    invoiceId: string,
    action: QcAction,
    actor: string,
  ): Promise<AppliedQcAction> {
    // `before`/`after` snapshots are caller-agnostic here; the service layer is
    // responsible for richer before/after capture when needed. We persist the
    // action payload as `after` for a faithful audit record.
    const created = await prisma.qcAction.create({
      data: {
        invoiceId,
        actor,
        type: action.type,
        after: action as unknown as object,
        note: "note" in action ? (action.note ?? null) : null,
      },
    });
    return {
      id: created.id,
      actor: created.actor,
      type: created.type as QcActionType,
      before: created.before ?? undefined,
      after: created.after ?? undefined,
      note: created.note ?? undefined,
      createdAt: created.createdAt.toISOString(),
    };
  }

  async saveSubmission(
    invoiceId: string,
    payload: SubmissionPayload,
    externalRef: string,
  ): Promise<void> {
    const payloadJson = payload as unknown as object;
    await prisma.submission.upsert({
      where: { invoiceId },
      create: {
        invoiceId,
        payload: payloadJson,
        externalRef,
      },
      update: {
        payload: payloadJson,
        externalRef,
        submittedAt: new Date(),
      },
    });
  }
}

export default PrismaInvoiceRepo;
