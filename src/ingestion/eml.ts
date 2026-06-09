/**
 * EmlFolderSource (FR1). Owned by the Ingestion module.
 * Enumerates a directory of *.eml files (RFC822 messages), parses each with
 * mailparser, and yields a RawInvoice for every PDF attachment found. This is the
 * offline / demo path for email ingestion — drop .eml fixtures into sample-emails/
 * (see scripts/make-sample-emails.ts) and the pipeline picks up their PDFs exactly
 * as if they had arrived over IMAP. Implements InvoiceSource (kind = "email").
 *
 * `poll` returns attachments not yet seen this process (keyed by messageId|fileName);
 * `list` returns every PDF attachment currently present. Mirrors DropFolderSource.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { InvoiceSource, RawInvoice } from "@/contracts";

/** Default demo email folder: .eml fixtures generated from the sample invoices. */
export const SAMPLE_EMAILS_DIR = path.resolve(process.cwd(), "sample-emails");

const PDF_MIME = "application/pdf";

function isPdfAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType?.toLowerCase() === PDF_MIME) return true;
  return (att.filename ?? "").toLowerCase().endsWith(".pdf");
}

function addressText(addr: ParsedMail["from"]): string | undefined {
  // `from` may be a single AddressObject (it is, per mailparser typings).
  return (addr as AddressObject | undefined)?.text;
}

export class EmlFolderSource implements InvoiceSource {
  readonly kind = "email";

  private readonly folder: string;
  private readonly seen = new Set<string>();

  constructor(folder?: string) {
    this.folder = folder ?? SAMPLE_EMAILS_DIR;
  }

  private async enumerate(): Promise<RawInvoice[]> {
    let entries: string[];
    try {
      entries = await readdir(this.folder);
    } catch {
      // Folder doesn't exist (or isn't readable) — nothing to ingest.
      return [];
    }

    const emlFiles = entries
      .filter((name) => path.extname(name).toLowerCase() === ".eml")
      .sort();

    const out: RawInvoice[] = [];
    for (const name of emlFiles) {
      const raw = await readFile(path.resolve(this.folder, name));
      let parsed: ParsedMail;
      try {
        parsed = await simpleParser(raw);
      } catch {
        // Skip messages mailparser can't read rather than failing the whole poll.
        continue;
      }

      const baseName = path.basename(name, ".eml");
      const pdfs = parsed.attachments.filter(isPdfAttachment);
      for (const att of pdfs) {
        out.push({
          fileName: att.filename ?? `${baseName}.pdf`,
          source: "email",
          bytes: att.content,
          mimeType: PDF_MIME,
          meta: {
            from: addressText(parsed.from),
            subject: parsed.subject,
            messageId: parsed.messageId,
            date: parsed.date?.toISOString(),
            emlFile: name,
          },
        } satisfies RawInvoice);
      }
    }
    return out;
  }

  private key(r: RawInvoice): string {
    const messageId = (r.meta?.messageId as string | undefined) ?? "";
    return `${messageId}|${r.fileName}`;
  }

  async poll(): Promise<RawInvoice[]> {
    const all = await this.enumerate();
    const fresh = all.filter((r) => !this.seen.has(this.key(r)));
    for (const r of fresh) this.seen.add(this.key(r));
    return fresh;
  }

  async list(): Promise<RawInvoice[]> {
    return this.enumerate();
  }
}

export default EmlFolderSource;
