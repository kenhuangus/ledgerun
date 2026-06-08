/**
 * Stage contracts — the per-stage input/output types and the stage FUNCTION TYPE
 * aliases the orchestrator is typed against. Mirrors architecture.md §4
 * (pipeline & state machine) and §6 (LLM-per-stage output contracts).
 *
 * Each stage is `(input, deps) => Promise<output>`. The orchestrator persists the
 * output and a StageEvent before invoking the next stage.
 *
 * LOCKED CONTRACT.
 */

import type {
  ExtractedInvoice,
  ExtractedLineItem,
  InvoiceMetadata,
  InvoiceState,
  ModelInfo,
} from "./invoice";
import type { CatalogItem, McpClient, RefId } from "./mcp";
import type { LlmClient } from "./llm";
import type {
  DecisionRecord,
  MatchOutcome,
  PolicyConfig,
  ResolutionStatus,
} from "./decision";

/* ----------------------------- Shared deps ------------------------------ */

/**
 * Minimal logger seam (pino-compatible). Stages/orchestrator log through this so
 * tests can inject a no-op.
 */
export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  /** Bind structured context (e.g. invoiceId, runId) to a child logger. */
  child(bindings: Record<string, unknown>): Logger;
}

/** Dependencies handed to every stage. Pure-ish stages take all collaborators here. */
export interface StageDeps {
  llm: LlmClient;
  mcp: McpClient;
  policy: PolicyConfig;
  logger: Logger;
}

/* ------------------------------- Extract -------------------------------- */

export interface ExtractInput {
  invoiceId: string;
  /** Extracted text layer of the PDF (ingestion already did pdf-parse/OCR). */
  documentText: string;
  fileName: string;
}

export interface ExtractOutput {
  extracted: ExtractedInvoice;
  /** Overall extraction confidence (Extraction.confidence). */
  confidence: number;
  modelInfo: ModelInfo;
}

/* ------------------------------- Resolve -------------------------------- */

/** A candidate considered during resolution, with the signal that surfaced it. */
export interface ResolutionCandidate {
  kind: "sponsor" | "study" | "site" | "study_site";
  refId: RefId;
  label: string;
  /** Which signal matched: protocol number, study name, sponsor name, site name. */
  matchedOn: "protocol_number" | "study_name" | "sponsor_name" | "site_name" | "other";
  score: number;
}

/** Structured evidence stored on ContextResolution.evidence. */
export interface ResolutionEvidence {
  /** All candidates the resolver weighed, for audit. */
  candidates: ResolutionCandidate[];
  /** Which signal ultimately won (priority: protocol# > study > sponsor > site). */
  decidingSignal?: ResolutionCandidate["matchedOn"];
  /** Corrections applied when invoice metadata conflicted with canonical data. */
  corrections?: Array<{
    field: keyof InvoiceMetadata;
    statedValue?: string;
    resolvedValue?: string;
    note?: string;
  }>;
  /** Tool calls made during the resolve loop, for the timeline. */
  toolCalls?: Array<{ name: string; input: unknown }>;
}

export interface ResolveInput {
  invoiceId: string;
  metadata: InvoiceMetadata;
}

export interface ResolveOutput {
  sponsorId?: RefId;
  studyId?: RefId;
  siteId?: RefId;
  studySiteId?: RefId;
  status: ResolutionStatus;
  confidence: number;
  evidence: ResolutionEvidence;
  modelInfo?: ModelInfo;
}

/* -------------------------------- Match --------------------------------- */

/** One ranked alternate considered for a line item. */
export interface MatchCandidate {
  catalogItemId: RefId;
  itemCode: string;
  description: string;
  catalogUnitPrice?: number | null;
  confidence: number;
}

/** A line item after matching — extends the extracted line with match results. */
export interface MatchedLineItem extends ExtractedLineItem {
  /** Index into the original extracted lineItems array (stable reference). */
  index: number;
  matchedItemId?: RefId | null;
  outcome: MatchOutcome;
  matchConfidence?: number;
  rationale?: string;
  candidates?: MatchCandidate[];
}

export interface MatchInput {
  invoiceId: string;
  /** Resolved scope — required to fetch the correct catalog. */
  sponsorId?: RefId;
  studyId?: RefId;
  lineItems: ExtractedLineItem[];
}

export interface MatchOutput {
  items: MatchedLineItem[];
  /** The scoped catalog actually fetched (for evidence/debug). May be omitted. */
  catalogSize?: number;
  modelInfo?: ModelInfo;
}

/* -------------------------------- Decide -------------------------------- */

export interface DecideInput {
  invoiceId: string;
  resolution: ResolveOutput;
  match: MatchOutput;
  metadata: InvoiceMetadata;
}

/** Decide's output IS the decision record (no LLM owns the verdict). */
export type DecideOutput = DecisionRecord;

/* --------------------------- Stage type aliases ------------------------- */

export type ExtractStage = (input: ExtractInput, deps: StageDeps) => Promise<ExtractOutput>;
export type ResolveStage = (input: ResolveInput, deps: StageDeps) => Promise<ResolveOutput>;
export type MatchStage = (input: MatchInput, deps: StageDeps) => Promise<MatchOutput>;
export type DecideStage = (input: DecideInput, deps: StageDeps) => Promise<DecideOutput>;

/* --------------------------- Observability ------------------------------ */

/** The pipeline stages, as recorded on StageEvent.stage. */
export type StageName = "extract" | "resolve" | "match" | "decide";

/** Status recorded on StageEvent.status (architecture.md §3 StageEvent). */
export type StageStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "retried"
  | "low_confidence";

/**
 * An observability record for one stage attempt. Mirrors the Prisma StageEvent
 * model; used by the orchestrator and rendered as the hub timeline (NFR5).
 */
export interface StageEvent {
  stage: StageName;
  status: StageStatus;
  latencyMs?: number;
  tokens?: number;
  inputRef?: unknown;
  outputRef?: unknown;
  error?: string;
  at: string; // ISO-8601
}

/**
 * The in-memory workflow state threaded through the orchestrator. Persisted
 * piecewise to the DB; this is the reducer's value (architecture.md §4 "plain
 * reducer over WorkflowState").
 */
export interface WorkflowState {
  invoiceId: string;
  runId?: string;
  state: InvoiceState;
  metadata?: InvoiceMetadata;
  extraction?: ExtractOutput;
  resolution?: ResolveOutput;
  match?: MatchOutput;
  decision?: DecideOutput;
  events: StageEvent[];
}

/** Catalog convenience alias re-exported for matchers that fetch then map. */
export type ScopedCatalog = CatalogItem[];
