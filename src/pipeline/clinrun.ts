/**
 * ClinRun submission client (prd.md §7) — STUB implementation. Owned by Stream D.
 *
 * No real ClinRun API exists in the take-home. On SUBMIT the system hands a
 * SubmissionPayload to a ClinRunClient; this stub records the handoff to a local
 * sink (logs it, and optionally appends it to a JSONL file) and returns a
 * synthetic externalRef. Everything is isolated behind the ClinRunClient
 * interface so a real HTTP endpoint can drop in later without touching callers.
 *
 * HELD invoices are never submitted (the orchestrator only calls submit() on a
 * SUBMIT verdict); this client makes no policy decision of its own.
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ClinRunClient,
  SubmissionPayload,
  SubmissionResult,
} from "@/contracts";
import { logger } from "@/lib/logger";

export interface StubClinRunOptions {
  /**
   * Optional path to a JSONL sink. When set, each submission payload is appended
   * as one JSON line — a durable "queue" stand-in a real ClinRun consumer (or a
   * demo/inspection) can read. When unset, the submission is logged only.
   */
  sinkPath?: string;
  /** Injectable id generator (tests pin it for determinism). */
  generateRef?: () => string;
  /** Injectable clock (tests pin it). Returns ISO-8601. */
  now?: () => string;
}

/**
 * Build the synthetic external reference. Format: `CR-<invoiceId>-<short uuid>`
 * so it is human-traceable back to the invoice while still unique per submit.
 */
function defaultRef(invoiceId: string): string {
  const short = randomUUID().split("-")[0];
  return `CR-${invoiceId}-${short}`;
}

export class StubClinRunClient implements ClinRunClient {
  private readonly sinkPath?: string;
  private readonly generateRef?: () => string;
  private readonly now: () => string;

  constructor(opts: StubClinRunOptions = {}) {
    this.sinkPath = opts.sinkPath;
    this.generateRef = opts.generateRef;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async submit(payload: SubmissionPayload): Promise<SubmissionResult> {
    const externalRef = this.generateRef
      ? this.generateRef()
      : defaultRef(payload.invoiceId);
    const at = this.now();

    const record = {
      externalRef,
      submittedAt: at,
      invoiceId: payload.invoiceId,
      verdict: payload.decision.verdict,
      policyVersion: payload.decision.policyVersion,
      context: payload.context,
      lineItemCount: payload.lineItems.length,
      payload,
    };

    logger.info(
      {
        invoiceId: payload.invoiceId,
        externalRef,
        verdict: payload.decision.verdict,
        lineItemCount: payload.lineItems.length,
        context: payload.context,
      },
      "ClinRun (stub) submission recorded",
    );

    if (this.sinkPath) {
      try {
        await mkdir(dirname(this.sinkPath), { recursive: true });
        await appendFile(this.sinkPath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (err) {
        // The sink is best-effort observability; never fail the submission on
        // a write error. The log above already captured the handoff.
        logger.warn(
          { invoiceId: payload.invoiceId, sinkPath: this.sinkPath, err: String(err) },
          "ClinRun (stub) sink write failed; submission still considered handed off",
        );
      }
    }

    return { externalRef };
  }
}

/** Default singleton used by the orchestrator. */
export const clinRunClient: ClinRunClient = new StubClinRunClient();

export default clinRunClient;
