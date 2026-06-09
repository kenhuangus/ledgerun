/**
 * Email-ingestion demo (FR1). `npm run demo:email` first regenerates the .eml
 * fixtures (via `make:emails`), then ingests every invoice that arrives as a PDF
 * attachment in an EMAIL through the real pipeline (Extract -> Resolve -> Match
 * -> Decide) and prints each verdict + exceptions.
 *
 * This proves the "ingest invoices from email" half of FR1 end to end: an
 * EmlFolderSource parses RFC822 messages, extracts the PDF attachment, and feeds
 * it to the exact same InvoiceService the drop-folder/upload paths use.
 *
 * Requires live services (same as `npm run demo`): ANTHROPIC_API_KEY, the
 * reference API reachable, and a Postgres DATABASE_URL with the schema pushed.
 */

import { EmlFolderSource, SAMPLE_EMAILS_DIR } from "@/ingestion/eml";
import { getInvoiceService } from "@/services/invoiceService";

async function main(): Promise<void> {
  // Exercise the real MCP path (stdio) by default, like the primary demo.
  if (!process.env.MCP_TRANSPORT) process.env.MCP_TRANSPORT = "stdio";

  const service = getInvoiceService();
  const source = new EmlFolderSource(SAMPLE_EMAILS_DIR);

  const raws = await source.poll();
  if (raws.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      `No invoice emails found in ${SAMPLE_EMAILS_DIR}. Run "npm run make:emails" first.`,
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Ingesting ${raws.length} invoice(s) arriving via EMAIL from ${SAMPLE_EMAILS_DIR}\n`);

  for (const raw of raws) {
    // eslint-disable-next-line no-console
    console.log(`=== ${raw.fileName}  (email: "${raw.meta?.subject ?? "?"}" from ${raw.meta?.from ?? "?"}) ===`);
    try {
      const { invoiceId, state } = await service.ingest(raw);
      const detail = await service.get(invoiceId);

      // eslint-disable-next-line no-console
      console.log(`  state:   ${state}`);
      // eslint-disable-next-line no-console
      console.log(`  verdict: ${detail?.decision?.verdict ?? "(no decision)"}`);
      // eslint-disable-next-line no-console
      console.log(`  context: ${detail?.resolution?.status ?? "(unresolved)"}`);

      const exceptions = (detail?.lineItems ?? []).filter((li) => li.outcome !== "matched_high");
      // eslint-disable-next-line no-console
      console.log(`  exceptions: ${exceptions.length === 0 ? "none" : exceptions.length}`);
      for (const ex of exceptions) {
        // eslint-disable-next-line no-console
        console.log(`    - [${ex.outcome}] ${ex.rawDescription}`);
      }
      for (const reason of detail?.decision?.reasons ?? []) {
        // eslint-disable-next-line no-console
        console.log(`  reason: [${reason.code}] ${reason.message}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    // eslint-disable-next-line no-console
    console.log("");
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
