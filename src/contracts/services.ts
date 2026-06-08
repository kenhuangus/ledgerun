/**
 * Service-layer contracts — the InvoiceService the Next.js API layer calls, plus
 * the QC action vocabulary (FR7). This is the seam that decouples the UI and the
 * orchestrator: route handlers/server actions call InvoiceService, never the
 * pipeline directly.
 *
 * LOCKED CONTRACT.
 */

import type { InvoiceState, InvoiceMetadata, ExtractedLineItem } from "./invoice";
import type { RawInvoice } from "./ingestion";
import type { DecisionRecord } from "./decision";
import type { RefId } from "./mcp";
import type {
  ExtractOutput,
  ResolveOutput,
  MatchOutput,
  MatchedLineItem,
  StageEvent,
  StageName,
} from "./stages";

/** QC action types (FR7 / architecture.md §3 QcAction.type). */
export type QcActionType =
  | "review"
  | "correct_metadata"
  | "correct_match"
  | "override_decision"
  | "rerun"
  | "escalate";

/** Payload for `correct_metadata` — fields the reviewer changed. */
export interface CorrectMetadataPayload {
  type: "correct_metadata";
  /** Partial metadata overrides (only changed fields). */
  metadata?: Partial<InvoiceMetadata>;
  /** Directly override resolved reference ids (e.g. confirm a correction). */
  sponsorId?: RefId;
  studyId?: RefId;
  siteId?: RefId;
  studySiteId?: RefId;
  note?: string;
}

/** Payload for `correct_match` — re-point or accept a line item's match. */
export interface CorrectMatchPayload {
  type: "correct_match";
  lineItemIndex: number;
  /** New catalog item id; null marks the line as legitimately unmatched/pass-through. */
  matchedItemId?: RefId | null;
  /** Accept an existing matched_low as-is. */
  accept?: boolean;
  note?: string;
}

/** Payload for `override_decision` — submit a held invoice or recall a submitted one. */
export interface OverrideDecisionPayload {
  type: "override_decision";
  verdict: DecisionRecord["verdict"];
  note?: string;
}

/** Payload for `rerun` — re-enter the pipeline from a chosen stage. */
export interface RerunPayload {
  type: "rerun";
  /** Stage to re-enter from; defaults to the earliest affected stage. */
  fromStage?: StageName;
  note?: string;
}

/** Payload for `escalate` — flag for someone else, keep out of auto-submit. */
export interface EscalatePayload {
  type: "escalate";
  note?: string;
  assignee?: string;
}

/** Payload for `review` — pure read/acknowledgement, optionally with a note. */
export interface ReviewPayload {
  type: "review";
  note?: string;
}

/** Discriminated union of all QC actions a reviewer can apply (FR7). */
export type QcAction =
  | ReviewPayload
  | CorrectMetadataPayload
  | CorrectMatchPayload
  | OverrideDecisionPayload
  | RerunPayload
  | EscalatePayload;

/** Filter for listing invoices in the hub queue. */
export interface InvoiceListFilter {
  state?: InvoiceState | InvoiceState[];
  /** Convenience lane filter: submitted stream vs held/exception queue. */
  lane?: "submitted" | "held" | "all";
  query?: string;
  limit?: number;
  offset?: number;
}

/** A compact invoice row for the queue view. */
export interface InvoiceSummary {
  id: string;
  fileName: string;
  source: string;
  state: InvoiceState;
  receivedAt: string;
  verdict?: DecisionRecord["verdict"];
  /** Count of line items flagged as exceptions, for the row badge. */
  exceptionCount: number;
}

/**
 * The full assembled view of one invoice for the detail screen (FR6): extracted
 * fields, matched line items, resolution, decision record, and the stage
 * timeline. All optional fields reflect how far the pipeline has progressed.
 */
export interface InvoiceDetail {
  id: string;
  fileName: string;
  source: string;
  rawUri: string;
  state: InvoiceState;
  receivedAt: string;
  metadata?: InvoiceMetadata;
  extraction?: ExtractOutput;
  resolution?: ResolveOutput;
  match?: MatchOutput;
  lineItems: MatchedLineItem[];
  decision?: DecisionRecord;
  events: StageEvent[];
  qcActions: AppliedQcAction[];
}

/** An applied QC action as stored/returned (architecture.md §3 QcAction). */
export interface AppliedQcAction {
  id: string;
  actor: string;
  type: QcActionType;
  before?: unknown;
  after?: unknown;
  note?: string;
  createdAt: string;
}

/** Result of applying a QC action. */
export interface QcActionResult {
  action: AppliedQcAction;
  /** Resulting invoice state (e.g. after a rerun kicks off). */
  state: InvoiceState;
  /** If the action triggered a rerun, the new decision once it completes. */
  decision?: DecisionRecord;
}

/**
 * The service the API layer calls. Decouples UI + orchestrator: route handlers
 * and server actions depend only on this interface.
 */
export interface InvoiceService {
  /** Ingest a raw invoice: store it and (typically) kick off the pipeline. */
  ingest(raw: RawInvoice): Promise<{ invoiceId: string; state: InvoiceState }>;
  /** Queue view. */
  list(filter?: InvoiceListFilter): Promise<InvoiceSummary[]>;
  /** Full detail view for one invoice (FR6). */
  get(id: string): Promise<InvoiceDetail | null>;
  /** Re-run the pipeline for an invoice, optionally from a given stage. */
  rerun(id: string, fromStage?: StageName): Promise<QcActionResult>;
  /** Apply a post-decision QC action (FR7). */
  applyQcAction(id: string, action: QcAction): Promise<QcActionResult>;
}

/** Re-export for service implementers that build extracted lines into details. */
export type { ExtractedLineItem };
