/**
 * Robust PDF text extraction (pdfjs-dist legacy build).
 *
 * Replaces pdf-parse, whose bundled pdfjs (v1) corrupts global state across
 * multiple sequential parses in one process — producing intermittent
 * "bad XRef entry" failures on perfectly valid PDFs (e.g. when ingesting a
 * batch of invoices in a single run). pdfjs-dist creates and destroys a fresh
 * document per call, so it is deterministic across any number of parses.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Extract the concatenated text layer from raw PDF bytes. */
export async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const doc = await getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((it) => ("str" in it ? it.str : ""))
          .join(" "),
      );
    }
    return pages.join("\n").trim();
  } finally {
    await doc.destroy();
  }
}

export default extractPdfText;
