/**
 * POST /api/invoices/[id]/rerun — re-enter the pipeline, optionally from a stage
 * (FR7). Thin handler: delegates to InvoiceService.rerun. Body: { fromStage? }.
 */

import { NextResponse } from "next/server";
import { getInvoiceService } from "@/services/invoiceService";
import type { StageName } from "@/contracts";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { fromStage?: StageName };
  const service = getInvoiceService();
  const result = await service.rerun(id, body.fromStage);
  return NextResponse.json(result);
}
