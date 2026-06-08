/**
 * UploadSource (FR1). Owned by the Ingestion module.
 * Wraps in-memory HTTP upload bytes as RawInvoices. Implements InvoiceSource
 * (`list` returns the pending upload(s)). `fromBytes` is the helper the upload
 * route uses to construct a RawInvoice from a multipart upload.
 */

import type { InvoiceSource, RawInvoice } from "@/contracts";

export class UploadSource implements InvoiceSource {
  readonly kind = "upload";

  constructor(private readonly pending: RawInvoice[] = []) {}

  async list(): Promise<RawInvoice[]> {
    return [...this.pending];
  }

  /** Build a RawInvoice from raw upload bytes (helper for the upload route). */
  static fromBytes(fileName: string, bytes: Uint8Array, mimeType: string): RawInvoice {
    return {
      fileName,
      source: "upload",
      bytes,
      mimeType: mimeType || "application/pdf",
      meta: { uploadedAt: new Date().toISOString() },
    };
  }
}

export default UploadSource;
