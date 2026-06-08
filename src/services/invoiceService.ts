/**
 * InvoiceService (architecture.md §2 API layer). Owned by the Service module.
 * The single seam the Next.js API/UI calls; decouples UI + orchestrator. Wires
 * ingestion -> repo -> orchestrator and applies post-decision QC actions (FR7).
 *
 * Core principle: ingest kicks the pipeline off autonomously to a verdict; there
 * is no human gate before the decision. Humans act only AFTER, via applyQcAction.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractPdfText } from "@/lib/pdf";

import type {
  InvoiceService,
  InvoiceListFilter,
  InvoiceSummary,
  InvoiceDetail,
  InvoiceState,
  RawInvoice,
  QcAction,
  QcActionResult,
  StageName,
  DecisionRecord,
  Verdict,
  MatchedLineItem,
  MatchOutput,
  InvoiceMetadata,
  ClinRunClient,
} from "@/contracts";
import { PrismaInvoiceRepo, type InvoiceRepo } from "@/repo/invoiceRepo";
import { createOrchestrator, type Orchestrator } from "@/pipeline/orchestrator";
import { extractStage } from "@/pipeline/extract";
import { resolveStage } from "@/pipeline/resolve";
import { matchStage } from "@/pipeline/match";
import { decideStage } from "@/pipeline/decide";
import { createLlmClient } from "@/llm/anthropic";
import { createMcpClient } from "@/mcp/client";
import { clinRunClient } from "@/pipeline/clinrun";
import { logger } from "@/lib/logger";
import { config, getPolicy } from "@/config";

/* --------------------------- document loading ------------------------- */

/** Extract the text layer of a PDF (pdfjs-dist; see src/lib/pdf.ts). */
async function pdfToText(bytes: Buffer): Promise<string> {
  return extractPdfText(bytes);
}

async function readRawBytes(rawUri: string): Promise<Buffer> {
  return readFile(rawUri);
}

/* ------------------------------- service ------------------------------ */

const DEFAULT_ACTOR = "qc-reviewer";

export class DefaultInvoiceService implements InvoiceService {
  private readonly repo: InvoiceRepo;
  private readonly orchestrator: Orchestrator;

  constructor(repo?: InvoiceRepo, orchestrator?: Orchestrator, clinRun?: ClinRunClient) {
    this.repo = repo ?? new PrismaInvoiceRepo();
    const deps = {
      llm: createLlmClient(),
      mcp: createMcpClient(),
      policy: getPolicy(),
      logger,
      repo: this.repo,
      clinRun: clinRun ?? clinRunClient,
      loadDocument: (invoiceId: string) => this.loadDocument(invoiceId),
    };
    this.orchestrator =
      orchestrator ??
      createOrchestrator(
        { extract: extractStage, resolve: resolveStage, match: matchStage, decide: decideStage },
        deps,
      );
  }

  /** Resolve the document text + filename for an invoice (used by the orchestrator). */
  private async loadDocument(
    invoiceId: string,
  ): Promise<{ documentText: string; fileName: string }> {
    const detail = await this.repo.getDetail(invoiceId);
    if (!detail) throw new Error(`Invoice not found: ${invoiceId}`);
    let documentText = "";
    try {
      const bytes = await readRawBytes(detail.rawUri);
      documentText = await pdfToText(bytes);
    } catch (err) {
      logger.warn(
        { invoiceId, err: err instanceof Error ? err.message : String(err) },
        "loadDocument: failed to read/parse PDF, using empty text",
      );
    }
    return { documentText, fileName: detail.fileName };
  }

  /**
   * Persist the raw invoice bytes to the upload dir (for in-memory uploads) or
   * keep the on-disk path (drop folder). Returns the canonical rawUri.
   */
  private async persistRaw(raw: RawInvoice): Promise<string> {
    if (raw.uri) return raw.uri;
    if (raw.bytes) {
      const dir = path.resolve(process.cwd(), config.UPLOAD_DIR);
      await mkdir(dir, { recursive: true });
      const safeName = `${Date.now()}-${path.basename(raw.fileName)}`;
      const dest = path.resolve(dir, safeName);
      await writeFile(dest, Buffer.from(raw.bytes));
      return dest;
    }
    throw new Error("RawInvoice has neither uri nor bytes");
  }

  async ingest(raw: RawInvoice): Promise<{ invoiceId: string; state: InvoiceState }> {
    const rawUri = await this.persistRaw(raw);
    const { id } = await this.repo.createFromRaw(raw, rawUri);
    // Kick off the pipeline autonomously to a verdict (no pre-decision gate).
    const result = await this.orchestrator.run(id);
    return { invoiceId: id, state: result.state };
  }

  async list(filter?: InvoiceListFilter): Promise<InvoiceSummary[]> {
    return this.repo.list(filter);
  }

  async get(id: string): Promise<InvoiceDetail | null> {
    return this.repo.getDetail(id);
  }

  async rerun(id: string, fromStage?: StageName): Promise<QcActionResult> {
    const action: QcAction = { type: "rerun", fromStage };
    const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
    const result = await this.orchestrator.run(id, { fromStage });
    return { action: applied, state: result.state, decision: result.decision };
  }

  async applyQcAction(id: string, action: QcAction): Promise<QcActionResult> {
    switch (action.type) {
      case "review":
      case "escalate": {
        // Pure annotation — record and report current state, no rerun.
        const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
        const state = (await this.repo.getState(id)) ?? "RECEIVED";
        const detail = await this.repo.getDetail(id);
        return { action: applied, state, decision: detail?.decision };
      }

      case "rerun": {
        const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
        const result = await this.orchestrator.run(id, { fromStage: action.fromStage });
        return { action: applied, state: result.state, decision: result.decision };
      }

      case "correct_metadata": {
        const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
        await this.applyMetadataCorrection(id, action);
        // Metadata changed → re-resolve (resolution depends on metadata), then
        // match + decide flow downstream.
        const result = await this.orchestrator.run(id, { fromStage: "resolve" });
        return { action: applied, state: result.state, decision: result.decision };
      }

      case "correct_match": {
        const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
        await this.applyMatchCorrection(id, action);
        // Match changed → re-decide only (deterministic policy over the corrected match).
        const result = await this.orchestrator.run(id, { fromStage: "decide" });
        return { action: applied, state: result.state, decision: result.decision };
      }

      case "override_decision": {
        const applied = await this.repo.recordQcAction(id, action, DEFAULT_ACTOR);
        const state = await this.applyDecisionOverride(id, action.verdict, action.note);
        const detail = await this.repo.getDetail(id);
        return { action: applied, state, decision: detail?.decision };
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`Unknown QC action: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /* ----------------------- correction persistence ---------------------- */

  private async applyMetadataCorrection(
    id: string,
    action: Extract<QcAction, { type: "correct_metadata" }>,
  ): Promise<void> {
    const detail = await this.repo.getDetail(id);
    if (!detail?.extraction) throw new Error("correct_metadata: no extraction to correct");

    // Merge field-level metadata overrides into the stored extraction.
    if (action.metadata) {
      const merged: InvoiceMetadata = {
        ...detail.extraction.extracted.metadata,
        ...action.metadata,
      };
      await this.repo.saveExtraction(id, {
        ...detail.extraction,
        extracted: { ...detail.extraction.extracted, metadata: merged },
      });
    }

    // Direct reference-id confirmations: pin them into the resolution so the
    // rerun's resolver can honor (or the existing resolution carries) them.
    const idOverrides =
      action.sponsorId !== undefined ||
      action.studyId !== undefined ||
      action.siteId !== undefined ||
      action.studySiteId !== undefined;
    if (idOverrides && detail.resolution) {
      await this.repo.saveResolution(id, {
        ...detail.resolution,
        sponsorId: action.sponsorId ?? detail.resolution.sponsorId,
        studyId: action.studyId ?? detail.resolution.studyId,
        siteId: action.siteId ?? detail.resolution.siteId,
        studySiteId: action.studySiteId ?? detail.resolution.studySiteId,
        status: "resolved_corrected",
      });
    }
  }

  private async applyMatchCorrection(
    id: string,
    action: Extract<QcAction, { type: "correct_match" }>,
  ): Promise<void> {
    const detail = await this.repo.getDetail(id);
    if (!detail) throw new Error("correct_match: invoice not found");

    const items: MatchedLineItem[] = detail.lineItems.map((li) => {
      if (li.index !== action.lineItemIndex) return li;
      if (action.accept) {
        // Accept an existing matched_low as-is → promote to matched_high.
        return { ...li, outcome: "matched_high", rationale: action.note ?? li.rationale };
      }
      // Re-point (or explicitly clear) the match.
      const matchedItemId = action.matchedItemId ?? null;
      return {
        ...li,
        matchedItemId,
        outcome: matchedItemId === null ? "unmatched" : "matched_high",
        matchConfidence: matchedItemId === null ? li.matchConfidence : 1,
        rationale: action.note ?? "Manual correction",
      };
    });

    const out: MatchOutput = { items, catalogSize: detail.match?.catalogSize };
    await this.repo.saveMatch(id, out);
  }

  private async applyDecisionOverride(
    id: string,
    verdict: Verdict,
    note?: string,
  ): Promise<InvoiceState> {
    const detail = await this.repo.getDetail(id);
    const prior = detail?.decision;
    const overridden: DecisionRecord = {
      verdict,
      reasons: [
        {
          code: verdict === "SUBMIT" ? "context_resolved" : "context_ambiguous",
          message: note ?? `Verdict manually overridden to ${verdict} by QC.`,
          evidence: { override: true, priorVerdict: prior?.verdict },
        },
        ...(prior?.reasons ?? []),
      ],
      policyVersion: prior?.policyVersion ?? getPolicy().policyVersion,
    };
    await this.repo.saveDecision(id, overridden);

    if (verdict === "SUBMIT") {
      await this.repo.setState(id, "SUBMITTED");
      return "SUBMITTED";
    }
    await this.repo.setState(id, "HELD");
    return "HELD";
  }
}

/** App-wide service instance the API layer imports. */
export function getInvoiceService(): InvoiceService {
  return new DefaultInvoiceService();
}

export default getInvoiceService;
