/**
 * make-sample-emails — generate .eml fixtures from the real sample PDFs.
 *
 * For each PDF in reference-api/sample-invoices/, hand-builds a valid RFC822
 * multipart/mixed message (text/plain body + base64 application/pdf attachment)
 * and writes it to sample-emails/<name>.eml. These fixtures feed EmlFolderSource
 * (the offline email-ingestion demo path) — no IMAP server required.
 *
 * Pure stdlib: the MIME is constructed by hand (base64 wrapped at 76 cols), so no
 * new dependency is introduced.
 *
 * Run: npx tsx scripts/make-sample-emails.ts
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SAMPLE_INVOICES_DIR = path.resolve(process.cwd(), "reference-api", "sample-invoices");
const SAMPLE_EMAILS_DIR = path.resolve(process.cwd(), "sample-emails");

/** Wrap a base64 string at 76 columns (RFC 2045 line-length limit). */
function wrapBase64(b64: string, cols = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += cols) {
    lines.push(b64.slice(i, i + cols));
  }
  return lines.join("\r\n");
}

/** Build one RFC822 multipart/mixed message wrapping `pdf` as an attachment. */
function buildEml(name: string, pdf: Buffer): string {
  const boundary = `----=_LedgerRun_${name.replace(/[^A-Za-z0-9]/g, "_")}`;
  const subject = `Invoice ${name}`;
  const date = new Date("2026-06-01T09:00:00Z").toUTCString();
  const messageId = `<${name}.${Date.parse(date)}@ledgerrun.local>`;
  const attachmentName = `${name}.pdf`;
  const body = `Please find attached invoice ${name} for processing.\r\n`;
  const encoded = wrapBase64(pdf.toString("base64"));

  return [
    `From: Billing <billing@vendor.example>`,
    `To: AP Inbox <invoices@ledgerrun.local>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `This is a multi-part message in MIME format.`,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    body,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${attachmentName}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${attachmentName}"`,
    ``,
    encoded,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

async function main(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(SAMPLE_INVOICES_DIR);
  } catch {
    console.error(`No sample invoices dir at ${SAMPLE_INVOICES_DIR}`);
    process.exitCode = 1;
    return;
  }

  const pdfs = entries.filter((f) => path.extname(f).toLowerCase() === ".pdf").sort();
  if (pdfs.length === 0) {
    console.error(`No PDFs found in ${SAMPLE_INVOICES_DIR}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(SAMPLE_EMAILS_DIR, { recursive: true });

  for (const pdfName of pdfs) {
    const base = path.basename(pdfName, ".pdf");
    const pdf = await readFile(path.resolve(SAMPLE_INVOICES_DIR, pdfName));
    const eml = buildEml(base, pdf);
    const dest = path.resolve(SAMPLE_EMAILS_DIR, `${base}.eml`);
    await writeFile(dest, eml, "utf8");
    console.log(`Wrote ${dest} (${pdf.length} bytes PDF attached)`);
  }

  console.log(`\nDone: ${pdfs.length} .eml fixture(s) in ${SAMPLE_EMAILS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
