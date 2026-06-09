/**
 * POST /api/invoices/[id]/qc — apply a post-decision QC action (FR7).
 * Thin handler: delegates to InvoiceService.applyQcAction.
 */

import { NextResponse } from "next/server";
import { getInvoiceService } from "@/services/invoiceService";
import type { QcAction } from "@/contracts";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const action = (await req.json()) as QcAction;
  const service = getInvoiceService();
  const result = await service.applyQcAction(id, action);
  return NextResponse.json(result);
}
