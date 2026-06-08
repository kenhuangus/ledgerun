/**
 * ClinRun submission contracts — the downstream handoff on a SUBMIT verdict
 * (prd.md §7, architecture.md §3 Submission). No real ClinRun API exists; the
 * impl writes a Submission record to a local sink, behind this interface so a
 * real endpoint can drop in later.
 *
 * LOCKED CONTRACT.
 */

import type { InvoiceMetadata, ExtractedLineItem } from "./invoice";
import type { DecisionRecord } from "./decision";
import type { RefId } from "./mcp";

/** A normalized line item plus the catalog item it matched to. */
export interface SubmissionLineItem {
  rawDescription: string;
  quantity?: number;
  unitPrice?: number;
  amount?: number;
  /** Reference catalog item id this line resolved to (null if pass-through). */
  matchedItemId?: RefId | null;
  /** Catalog item code for human-readable cross-reference. */
  matchedItemCode?: string;
}

/**
 * The payload handed to ClinRun on SUBMIT: the normalized invoice, the resolved
 * clinical-trial context (reference ids), the matched catalog refs, and the
 * decision record that authorized the submission.
 */
export interface SubmissionPayload {
  invoiceId: string;
  metadata: InvoiceMetadata;
  /** Resolved reference context (the ids the line items were scoped against). */
  context: {
    sponsorId?: RefId;
    studyId?: RefId;
    siteId?: RefId;
    studySiteId?: RefId;
  };
  lineItems: SubmissionLineItem[];
  /** Echo of the original extracted lines, for downstream audit if needed. */
  extractedLineItems?: ExtractedLineItem[];
  decision: DecisionRecord;
}

/** Result of a submission. */
export interface SubmissionResult {
  /** Identifier returned by the (stubbed) downstream system. */
  externalRef: string;
}

/** The downstream submission client. Swappable for a real ClinRun endpoint. */
export interface ClinRunClient {
  submit(payload: SubmissionPayload): Promise<SubmissionResult>;
}
