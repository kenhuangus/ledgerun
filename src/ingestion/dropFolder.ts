/**
 * DropFolderSource (FR1). Owned by the Ingestion module.
 * Enumerates a directory of invoice files (config.DROP_FOLDER, pointed at the
 * reference-api sample-invoices/ for the demo) and yields RawInvoices. Implements
 * InvoiceSource. `poll` returns files not yet seen this process; `list` returns
 * every file currently present.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { InvoiceSource, RawInvoice, InvoiceSourceKind } from "@/contracts";
import { config } from "@/config";

/** Default demo drop folder: the four sample invoices shipped with the reference API. */
export const SAMPLE_INVOICES_DIR = path.resolve(
  process.cwd(),
  "reference-api",
  "sample-invoices",
);

const SUPPORTED_EXT = new Set([".pdf"]);

function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

export class DropFolderSource implements InvoiceSource {
  readonly kind = "drop-folder";

  private readonly folder: string;
  private readonly seen = new Set<string>();
  private readonly sourceKind: InvoiceSourceKind;

  constructor(folder?: string, sourceKind: InvoiceSourceKind = "sample") {
    // Default to the configured drop folder; if that is the placeholder ".drop"
    // and does not exist, callers can pass SAMPLE_INVOICES_DIR explicitly.
    this.folder = folder ?? config.DROP_FOLDER;
    this.sourceKind = sourceKind;
  }

  private async enumerate(): Promise<RawInvoice[]> {
    let entries: string[];
    try {
      entries = await readdir(this.folder);
    } catch {
      return [];
    }
    return entries
      .filter((name) => SUPPORTED_EXT.has(path.extname(name).toLowerCase()))
      .sort()
      .map((name) => {
        const uri = path.resolve(this.folder, name);
        return {
          fileName: name,
          source: this.sourceKind,
          uri,
          mimeType: mimeFor(path.extname(name)),
          meta: { folder: this.folder },
        } satisfies RawInvoice;
      });
  }

  async poll(): Promise<RawInvoice[]> {
    const all = await this.enumerate();
    const fresh = all.filter((r) => !this.seen.has(r.uri!));
    for (const r of fresh) this.seen.add(r.uri!);
    return fresh;
  }

  async list(): Promise<RawInvoice[]> {
    return this.enumerate();
  }
}

export default DropFolderSource;
