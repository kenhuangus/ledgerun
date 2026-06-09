/**
 * Demo script (NFR7). `npm run demo` ingests the four sample invoices in
 * reference-api/sample-invoices end to end through the REAL pipeline
 * (Extract -> Resolve -> Match -> Decide) and prints each invoice's verdict and
 * exceptions. Wires DropFolderSource -> InvoiceService -> orchestrator.
 *
 * Requires live services:
 *   - ANTHROPIC_API_KEY set (the LLM behind extract/resolve/match),
 *   - the reference API reachable (REFERENCE_API_URL, default http://localhost:8000),
 *   - a Postgres DATABASE_URL with the schema pushed (`npm run db:push`).
 *
 * The offline proof of the wiring is tests/integration/pipeline.test.ts; this
 * script is the live end-to-end walkthrough.
 */

import { DropFolderSource, SAMPLE_INVOICES_DIR } from "@/ingestion/dropFolder";
import { getInvoiceService } from "@/services/invoiceService";

async function main(): Promise<void> {
  // Exercise the REAL MCP path by default: the orchestrator resolves context and
  // fetches the scoped catalog through the MCP server over stdio (FR3 — "via the
  // MCP-wrapped reference API"). Set MCP_TRANSPORT=http to use the in-process
  // DirectMcpClient instead.
  if (!process.env.MCP_TRANSPORT) process.env.MCP_TRANSPORT = "stdio";

  const service = getInvoiceService();
  const source = new DropFolderSource(SAMPLE_INVOICES_DIR, "sample");

  const raws = await source.list();
  if (raws.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`No sample invoices found in ${SAMPLE_INVOICES_DIR}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Ingesting ${raws.length} sample invoice(s) from ${SAMPLE_INVOICES_DIR}\n`);

  for (const raw of raws) {
    // eslint-disable-next-line no-console
    console.log(`=== ${raw.fileName} ===`);
    try {
      const { invoiceId, state } = await service.ingest(raw);
      const detail = await service.get(invoiceId);

      const verdict = detail?.decision?.verdict ?? "(no decision)";
      // eslint-disable-next-line no-console
      console.log(`  state:   ${state}`);
      // eslint-disable-next-line no-console
      console.log(`  verdict: ${verdict}`);
      // eslint-disable-next-line no-console
      console.log(`  context: ${detail?.resolution?.status ?? "(unresolved)"}`);

      const exceptions = (detail?.lineItems ?? []).filter(
        (li) => li.outcome !== "matched_high",
      );
      if (exceptions.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  exceptions (${exceptions.length}):`);
        for (const ex of exceptions) {
          // eslint-disable-next-line no-console
          console.log(`    - [${ex.outcome}] ${ex.rawDescription}`);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log("  exceptions: none");
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
