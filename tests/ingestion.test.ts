/**
 * EmlFolderSource unit test (FR1, email ingestion). Self-contained and offline:
 * builds an in-memory .eml by wrapping the REAL simple-invoice.pdf into a
 * multipart/mixed message, writes it to a fixed temp dir, points EmlFolderSource
 * at that dir, and asserts the PDF attachment surfaces as a RawInvoice with the
 * right shape + headers. Also proves poll() de-dupes (yields once, then []).
 *
 * No network, no IMAP, no DB.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EmlFolderSource } from "@/ingestion/eml";

const TMP_DIR = path.join(os.tmpdir(), "ledgerrun-eml-test");
const SAMPLE_PDF = path.resolve(process.cwd(), "reference-api", "sample-invoices", "simple-invoice.pdf");

/** Wrap base64 at 76 cols, RFC 2045 style. */
function wrapBase64(b64: string, cols = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += cols) lines.push(b64.slice(i, i + cols));
  return lines.join("\r\n");
}

function buildEml(pdf: Buffer): string {
  const boundary = "----=_LedgerRunTest";
  const encoded = wrapBase64(pdf.toString("base64"));
  return [
    `From: Billing <billing@vendor.example>`,
    `To: AP Inbox <invoices@ledgerrun.local>`,
    `Subject: Invoice simple-invoice`,
    `Date: ${new Date("2026-06-01T09:00:00Z").toUTCString()}`,
    `Message-ID: <simple-invoice@ledgerrun.local>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    `Please find the attached invoice.`,
    `--${boundary}`,
    `Content-Type: application/pdf; name="simple-invoice.pdf"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="simple-invoice.pdf"`,
    ``,
    encoded,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

describe("EmlFolderSource (email ingestion, offline)", () => {
  beforeAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(TMP_DIR, { recursive: true });
    const pdf = await readFile(SAMPLE_PDF);
    await writeFile(path.join(TMP_DIR, "simple-invoice.eml"), buildEml(pdf), "utf8");
  });

  it("list() yields one PDF RawInvoice with populated bytes + headers", async () => {
    const source = new EmlFolderSource(TMP_DIR);
    expect(source.kind).toBe("email");

    const items = await source.list();
    expect(items).toHaveLength(1);

    const [raw] = items;
    expect(raw.source).toBe("email");
    expect(raw.mimeType).toBe("application/pdf");
    expect(raw.fileName).toBe("simple-invoice.pdf");

    // Bytes round-tripped through base64 and carry a valid PDF header.
    expect(raw.bytes).toBeDefined();
    expect(raw.bytes!.length).toBeGreaterThan(0);
    const header = Buffer.from(raw.bytes!.slice(0, 5)).toString("latin1");
    expect(header).toBe("%PDF-");

    // Email headers surfaced into meta.
    expect(raw.meta?.subject).toBe("Invoice simple-invoice");
    expect(String(raw.meta?.from)).toContain("billing@vendor.example");
    expect(raw.meta?.emlFile).toBe("simple-invoice.eml");
  });

  it("poll() returns the item once, then [] on the second poll", async () => {
    const source = new EmlFolderSource(TMP_DIR);
    const first = await source.poll();
    expect(first).toHaveLength(1);
    expect(first[0].source).toBe("email");

    const second = await source.poll();
    expect(second).toHaveLength(0);
  });

  it("returns [] for a non-existent folder instead of throwing", async () => {
    const source = new EmlFolderSource(path.join(TMP_DIR, "does-not-exist"));
    await expect(source.list()).resolves.toEqual([]);
  });
});
