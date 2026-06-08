/**
 * Invoice domain contracts — the shapes the Extract stage produces and the rest
 * of the pipeline consumes. Mirrors architecture.md §3 (Extraction.metadata,
 * LineItem) and prd.md FR2.
 *
 * LOCKED CONTRACT. Modules import these; do not change shapes without
 * coordinating across all six module agents.
 */

/**
 * Workflow state. MUST mirror the Prisma `InvoiceState` enum exactly
 * (prisma/schema.prisma). Kept as a string-literal union so non-DB code (UI,
 * orchestrator, tests) can use it without importing @prisma/client.
 */
export type InvoiceState =
  | "RECEIVED"
  | "EXTRACTING"
  | "EXTRACTED"
  | "RESOLVING"
  | "CONTEXT_RESOLVED"
  | "MATCHING"
  | "MATCHED"
  | "DECIDING"
  | "SUBMITTED"
  | "HELD"
  | "FAILED";

/** Where a raw invoice came from. Mirrors Invoice.source. */
export type InvoiceSourceKind = "email" | "upload" | "sample";

/** ISO-4217 currency code (e.g. "USD"). Free string; not validated at type level. */
export type CurrencyCode = string;

/** A monetary value with its currency. Amounts are in major units (e.g. dollars). */
export interface Money {
  amount: number;
  currency: CurrencyCode;
}

/**
 * Where in the source document a value came from, for auditability (FR2
 * "per-field provenance"). All fields optional because not every extraction can
 * cite a precise location.
 */
export interface Provenance {
  /** Verbatim text the LLM read the value from. */
  sourceText?: string;
  /** 1-based page number in the source PDF, if known. */
  page?: number;
  /** Free-form locator (line number, bbox, section label). */
  locator?: string;
}

/**
 * A single extracted metadata value carrying its confidence + provenance.
 * Generic so each field keeps its own value type.
 */
export interface ProvenancedValue<T> {
  value: T;
  /** 0..1 model confidence in this specific field. */
  confidence: number;
  provenance?: Provenance;
}

/**
 * Structured invoice metadata produced by Extract (FR2). Each field is a
 * ProvenancedValue so the hub can show what was read, from where, and how
 * confidently. Any field may be absent if the document did not state it.
 *
 * Stored as Extraction.metadata (Json).
 */
export interface InvoiceMetadata {
  /** Sponsor name AS WRITTEN on the invoice (may be wrong/abbreviated). */
  sponsorName?: ProvenancedValue<string>;
  /** Study name AS WRITTEN. */
  studyName?: ProvenancedValue<string>;
  /** Protocol / study number AS WRITTEN (highest-priority resolution signal). */
  protocolNumber?: ProvenancedValue<string>;
  /** Site name AS WRITTEN. */
  siteName?: ProvenancedValue<string>;
  /** Vendor's invoice number / identifier. */
  invoiceNumber?: ProvenancedValue<string>;
  /** Invoice issue date, ISO-8601 string (YYYY-MM-DD). */
  invoiceDate?: ProvenancedValue<string>;
  /** Optional due date, ISO-8601 string. */
  dueDate?: ProvenancedValue<string>;
  /** Currency for the whole invoice. */
  currency?: ProvenancedValue<CurrencyCode>;
  /** Stated subtotal (pre-tax/adjustment), if present. */
  subtotal?: ProvenancedValue<number>;
  /** Stated tax amount, if present. */
  tax?: ProvenancedValue<number>;
  /** Stated grand total — reconciled against the sum of line amounts in Decide. */
  total?: ProvenancedValue<number>;
}

/**
 * One extracted line item (FR2). Raw, pre-match — the matched catalog item id,
 * outcome, confidence and rationale are added by the Match stage and live on the
 * LineItem record (see stages.ts MatchedLineItem).
 */
export interface ExtractedLineItem {
  /** Line description verbatim from the invoice. */
  rawDescription: string;
  quantity?: number;
  unitPrice?: number;
  /** Line total as stated on the invoice. */
  amount?: number;
  /** 0..1 confidence in this line's extraction. */
  confidence: number;
  provenance?: Provenance;
}

/** The full structured output of the Extract stage. */
export interface ExtractedInvoice {
  metadata: InvoiceMetadata;
  lineItems: ExtractedLineItem[];
}

/** Model + prompt versioning captured on every LLM result (Extraction.modelInfo). */
export interface ModelInfo {
  /** Provider model id, e.g. "claude-opus-4-8". */
  model: string;
  /** Our prompt template version, for reproducibility. */
  promptVersion: string;
  /** Token usage if the provider reported it. */
  inputTokens?: number;
  outputTokens?: number;
}
