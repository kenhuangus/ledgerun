/**
 * Pipeline orchestrator (architecture.md §4). Owned by the Orchestrator module.
 * Drives Extract -> Resolve -> Match -> Decide as a state machine over
 * WorkflowState; persists every transition as a StageEvent; owns bounded-backoff
 * retry/recovery. Runs fully autonomously with NO human gate before the decision
 * (core principle). On the verdict it sets SUBMITTED/HELD and, on SUBMIT, calls
 * the ClinRunClient. Reruns are idempotent and re-enter from a chosen stage.
 */

import type {
  StageDeps,
  StageName,
  StageStatus,
  StageEvent,
  WorkflowState,
  InvoiceState,
  ExtractStage,
  ResolveStage,
  MatchStage,
  DecideStage,
  ExtractOutput,
  ResolveOutput,
  MatchOutput,
  DecideOutput,
  InvoiceMetadata,
  ClinRunClient,
  SubmissionPayload,
  SubmissionLineItem,
} from "@/contracts";
import type { InvoiceRepo } from "@/repo/invoiceRepo";

/** The concrete stage functions the orchestrator drives. */
export interface PipelineStages {
  extract: ExtractStage;
  resolve: ResolveStage;
  match: MatchStage;
  decide: DecideStage;
}

export interface RunOptions {
  /** Re-enter from this stage (QC rerun); defaults to the start. */
  fromStage?: StageName;
}

export interface Orchestrator {
  /** Run an already-ingested invoice through the pipeline to a verdict. */
  run(invoiceId: string, options?: RunOptions): Promise<WorkflowState>;
}

/**
 * Collaborators the orchestrator needs beyond the stage deps: persistence, the
 * downstream submission client, and a way to obtain the document text for an
 * invoice (PDF text layer). Injected so the orchestrator stays testable.
 */
export interface OrchestratorDeps extends StageDeps {
  repo: InvoiceRepo;
  clinRun: ClinRunClient;
  /** Resolve the extractable document text + filename for the invoice. */
  loadDocument(invoiceId: string): Promise<{ documentText: string; fileName: string }>;
}

/* ----------------------------- retry policy --------------------------- */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

/** Heuristic: is this a transient error worth retrying (429/5xx/network)? */
function isTransient(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  return [
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "network",
    "fetch failed",
    "rate limit",
    "overloaded",
    "temporarily",
  ].some((needle) => msg.includes(needle));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ----------------------------- state ordering ------------------------- */

const STAGE_ORDER: StageName[] = ["extract", "resolve", "match", "decide"];

/** In-progress / done states for each stage, used to drive transitions. */
const STAGE_STATES: Record<
  StageName,
  { running: InvoiceState; done: InvoiceState }
> = {
  extract: { running: "EXTRACTING", done: "EXTRACTED" },
  resolve: { running: "RESOLVING", done: "CONTEXT_RESOLVED" },
  match: { running: "MATCHING", done: "MATCHED" },
  decide: { running: "DECIDING", done: "SUBMITTED" /* overridden by verdict */ },
};

/* ----------------------------- orchestrator --------------------------- */

export function createOrchestrator(
  stages: PipelineStages,
  deps: OrchestratorDeps,
): Orchestrator {
  const { repo, clinRun } = deps;

  async function emit(
    runId: string,
    events: StageEvent[],
    ev: Omit<StageEvent, "at"> & { at?: string },
  ): Promise<void> {
    const full: StageEvent = { ...ev, at: ev.at ?? new Date().toISOString() };
    events.push(full);
    await repo.appendStageEvent(runId, full);
  }

  /**
   * Run one stage with bounded-backoff retry. Persists started / retried /
   * succeeded / failed StageEvents. Returns the stage output or throws after the
   * final attempt (caller maps to FAILED).
   */
  async function runStage<T>(
    runId: string,
    events: StageEvent[],
    stage: StageName,
    fn: () => Promise<T>,
    extractStatus?: (out: T) => StageStatus | undefined,
    extractTokens?: (out: T) => number | undefined,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = Date.now();
      await emit(runId, events, { stage, status: "started" });
      try {
        const out = await fn();
        const latencyMs = Date.now() - startedAt;
        const status = extractStatus?.(out) ?? "succeeded";
        await emit(runId, events, {
          stage,
          status,
          latencyMs,
          tokens: extractTokens?.(out),
        });
        return out;
      } catch (err) {
        lastErr = err;
        const latencyMs = Date.now() - startedAt;
        const transient = isTransient(err);
        const willRetry = transient && attempt < MAX_ATTEMPTS;
        await emit(runId, events, {
          stage,
          status: willRetry ? "retried" : "failed",
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!willRetry) break;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }

  async function setState(state: WorkflowState, next: InvoiceState): Promise<void> {
    state.state = next;
    await repo.setState(state.invoiceId, next);
  }

  function tokensOf(out: { modelInfo?: { inputTokens?: number; outputTokens?: number } }): number | undefined {
    const mi = out.modelInfo;
    if (!mi) return undefined;
    const t = (mi.inputTokens ?? 0) + (mi.outputTokens ?? 0);
    return t > 0 ? t : undefined;
  }

  async function buildSubmissionPayload(
    state: WorkflowState,
  ): Promise<SubmissionPayload> {
    const metadata: InvoiceMetadata = state.metadata ?? {};
    const matched = state.match?.items ?? [];
    const lineItems: SubmissionLineItem[] = matched.map((m) => {
      const candidate = m.candidates?.find((c) => c.catalogItemId === m.matchedItemId);
      return {
        rawDescription: m.rawDescription,
        quantity: m.quantity,
        unitPrice: m.unitPrice,
        amount: m.amount,
        matchedItemId: m.matchedItemId ?? null,
        matchedItemCode: candidate?.itemCode,
      };
    });
    return {
      invoiceId: state.invoiceId,
      metadata,
      context: {
        sponsorId: state.resolution?.sponsorId,
        studyId: state.resolution?.studyId,
        siteId: state.resolution?.siteId,
        studySiteId: state.resolution?.studySiteId,
      },
      lineItems,
      extractedLineItems: state.extraction?.extracted.lineItems,
      decision: state.decision!,
    };
  }

  async function run(invoiceId: string, options?: RunOptions): Promise<WorkflowState> {
    const logger = deps.logger.child({ invoiceId });
    const { runId } = await repo.ensureRun(invoiceId);

    const state: WorkflowState = {
      invoiceId,
      runId,
      state: "RECEIVED",
      events: [],
    };

    // Determine the entry point. A rerun from a later stage requires the prior
    // stages' outputs to already be persisted — hydrate them from the detail.
    const fromStage = options?.fromStage ?? "extract";
    const startIdx = STAGE_ORDER.indexOf(fromStage);

    if (startIdx > 0) {
      const detail = await repo.getDetail(invoiceId);
      if (!detail) throw new Error(`Invoice not found: ${invoiceId}`);
      state.metadata = detail.metadata;
      state.extraction = detail.extraction;
      state.resolution = detail.resolution;
      state.match = detail.match;
      state.decision = detail.decision;
    }

    try {
      /* ---------------------------- Extract ---------------------------- */
      if (startIdx <= STAGE_ORDER.indexOf("extract")) {
        await setState(state, STAGE_STATES.extract.running);
        const doc = await deps.loadDocument(invoiceId);
        const out: ExtractOutput = await runStage(
          runId,
          state.events,
          "extract",
          () =>
            stages.extract(
              { invoiceId, documentText: doc.documentText, fileName: doc.fileName },
              deps,
            ),
          (o) => (o.confidence < deps.policy.lowConfidence ? "low_confidence" : "succeeded"),
          (o) => tokensOf(o),
        );
        state.extraction = out;
        state.metadata = out.extracted.metadata;
        await repo.saveExtraction(invoiceId, out);
        await setState(state, STAGE_STATES.extract.done);
      }

      /* ---------------------------- Resolve ---------------------------- */
      if (startIdx <= STAGE_ORDER.indexOf("resolve")) {
        if (!state.metadata) throw new Error("resolve: missing extracted metadata");
        await setState(state, STAGE_STATES.resolve.running);
        const out: ResolveOutput = await runStage(
          runId,
          state.events,
          "resolve",
          () => stages.resolve({ invoiceId, metadata: state.metadata! }, deps),
          (o) =>
            o.status === "ambiguous" || o.status === "unresolved"
              ? "low_confidence"
              : "succeeded",
          (o) => tokensOf(o),
        );
        state.resolution = out;
        await repo.saveResolution(invoiceId, out);
        // Ambiguity is carried, not blocked — always advance to CONTEXT_RESOLVED.
        await setState(state, STAGE_STATES.resolve.done);
      }

      /* ----------------------------- Match ----------------------------- */
      if (startIdx <= STAGE_ORDER.indexOf("match")) {
        if (!state.extraction) throw new Error("match: missing extraction");
        await setState(state, STAGE_STATES.match.running);
        const out: MatchOutput = await runStage(
          runId,
          state.events,
          "match",
          () =>
            stages.match(
              {
                invoiceId,
                sponsorId: state.resolution?.sponsorId,
                studyId: state.resolution?.studyId,
                lineItems: state.extraction!.extracted.lineItems,
              },
              deps,
            ),
          () => "succeeded",
          (o) => tokensOf(o),
        );
        state.match = out;
        await repo.saveMatch(invoiceId, out);
        await setState(state, STAGE_STATES.match.done);
      }

      /* ----------------------------- Decide ---------------------------- */
      if (startIdx <= STAGE_ORDER.indexOf("decide")) {
        if (!state.resolution || !state.match) {
          throw new Error("decide: missing resolution or match");
        }
        await setState(state, STAGE_STATES.decide.running);
        const decision: DecideOutput = await runStage(
          runId,
          state.events,
          "decide",
          () =>
            stages.decide(
              {
                invoiceId,
                resolution: state.resolution!,
                match: state.match!,
                metadata: state.metadata ?? {},
              },
              deps,
            ),
        );
        state.decision = decision;
        await repo.saveDecision(invoiceId, decision);

        if (decision.verdict === "SUBMIT") {
          // Hand to the downstream system before declaring SUBMITTED so a
          // submission failure parks the invoice as a hard failure (visible, rerun-able).
          const payload = await buildSubmissionPayload(state);
          const { externalRef } = await runStage(
            runId,
            state.events,
            "decide",
            () => clinRun.submit(payload),
          );
          await repo.saveSubmission(invoiceId, payload, externalRef);
          await setState(state, "SUBMITTED");
        } else {
          await setState(state, "HELD");
        }
      }

      // Mark the run complete.
      logger.info({ state: state.state }, "pipeline run complete");
      return state;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "pipeline run failed",
      );
      await setState(state, "FAILED");
      return state;
    }
  }

  return { run };
}

export default createOrchestrator;
