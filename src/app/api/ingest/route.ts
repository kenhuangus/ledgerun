/**
 * POST /api/ingest — ingest every sample invoice from the drop folder (FR1, demo).
 * Thin handler: enumerates the sample drop folder and calls InvoiceService.ingest
 * for each file. Returns the ingested ids.
 */

import { NextResponse } from "next/server";
import { getInvoiceService } from "@/services/invoiceService";
import { DropFolderSource, SAMPLE_INVOICES_DIR } from "@/ingestion/dropFolder";

export async function POST(): Promise<Response> {
  const service = getInvoiceService();
  const source = new DropFolderSource(SAMPLE_INVOICES_DIR, "sample");

  const raws = (await source.list?.()) ?? [];
  if (raws.length === 0) {
    return NextResponse.json(
      { error: "no sample invoices found", dir: SAMPLE_INVOICES_DIR, ingested: [] },
      { status: 404 },
    );
  }

  const ingested: Array<{ invoiceId: string; state: string; fileName: string }> = [];
  for (const raw of raws) {
    try {
      const res = await service.ingest(raw);
      ingested.push({ ...res, fileName: raw.fileName });
    } catch (e) {
      ingested.push({
        invoiceId: "",
        state: "FAILED",
        fileName: raw.fileName,
      });
      // Continue ingesting the rest; surface failure count below.
      void e;
    }
  }

  return NextResponse.json({ count: ingested.length, ingested });
}
