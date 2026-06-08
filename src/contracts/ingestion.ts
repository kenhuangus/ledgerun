/**
 * Ingestion contracts — how raw invoices enter the system (FR1). Implementations:
 * DropFolderSource (samples), UploadSource, optional ImapSource.
 *
 * LOCKED CONTRACT.
 */

import type { InvoiceSourceKind } from "./invoice";

/**
 * A raw, un-extracted invoice as picked up by an ingestion source. Exactly one
 * of `bytes` / `uri` is required (bytes for in-memory uploads, uri for a file or
 * blob already on disk/storage).
 */
export interface RawInvoice {
  fileName: string;
  source: InvoiceSourceKind;
  /** File contents in memory (e.g. an HTTP upload). */
  bytes?: Uint8Array;
  /** Location of the file/blob if not held in memory (e.g. drop-folder path). */
  uri?: string;
  /** MIME type, e.g. "application/pdf". */
  mimeType: string;
  /** Optional source-specific metadata (email headers, upload actor, etc.). */
  meta?: Record<string, unknown>;
}

/**
 * A pluggable invoice source (FR1). The ingestion adapter abstracts the inbox;
 * `poll` is for sources that are checked on a schedule (IMAP, drop folder),
 * `list` is a one-shot enumeration (e.g. read every sample PDF once).
 *
 * Implementations may support either or both; callers should prefer `poll` for
 * continuous sources and `list` for batch ingestion.
 */
export interface InvoiceSource {
  /** Stable identifier for this source, e.g. "drop-folder" | "upload" | "imap". */
  readonly kind: string;
  /** Return newly-seen raw invoices since the last poll (may be empty). */
  poll?(): Promise<RawInvoice[]>;
  /** Enumerate all currently-available raw invoices. */
  list?(): Promise<RawInvoice[]>;
}
