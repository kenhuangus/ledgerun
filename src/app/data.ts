/**
 * Server-only data access for hub pages. Server components call these directly
 * through the InvoiceService seam (no HTTP round-trip to our own API). The API
 * routes under /api exist for client-side mutations and external callers.
 */

import { getInvoiceService } from "@/services/invoiceService";
import type { InvoiceListFilter, InvoiceSummary, InvoiceDetail } from "@/contracts";

export async function listInvoices(filter?: InvoiceListFilter): Promise<InvoiceSummary[]> {
  return getInvoiceService().list(filter);
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  return getInvoiceService().get(id);
}
