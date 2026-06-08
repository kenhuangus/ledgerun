/**
 * GET /api/invoices/[id] — full invoice detail (FR6). STUB.
 * Owned by the API/Service module. Delegates to InvoiceService.get.
 */

import { NextResponse } from "next/server";
import { getInvoiceService } from "@/services/invoiceService";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const service = getInvoiceService();
  const detail = await service.get(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
