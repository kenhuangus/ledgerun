/**
 * GET /api/invoices — list the queue (FR6). Supports ?lane=submitted|held|all,
 * repeated ?state=, ?query=, ?limit=, ?offset=.
 * POST /api/invoices — ingest a single uploaded invoice (multipart or JSON).
 * Thin handlers: delegate to InvoiceService.
 */

import { NextResponse } from "next/server";
import { getInvoiceService } from "@/services/invoiceService";
import type { InvoiceListFilter, InvoiceState, RawInvoice } from "@/contracts";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const filter: InvoiceListFilter = {};
  const lane = sp.get("lane");
  if (lane === "submitted" || lane === "held" || lane === "all") filter.lane = lane;

  const states = sp.getAll("state") as InvoiceState[];
  if (states.length === 1) filter.state = states[0];
  else if (states.length > 1) filter.state = states;

  const query = sp.get("query");
  if (query) filter.query = query;

  const limit = sp.get("limit");
  if (limit) filter.limit = Number(limit);
  const offset = sp.get("offset");
  if (offset) filter.offset = Number(offset);

  const service = getInvoiceService();
  const items = await service.list(Object.keys(filter).length ? filter : undefined);
  return NextResponse.json({ items });
}

export async function POST(req: Request): Promise<Response> {
  const service = getInvoiceService();
  const contentType = req.headers.get("content-type") ?? "";

  let raw: RawInvoice;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing file" }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    raw = {
      fileName: file.name,
      source: "upload",
      bytes,
      mimeType: file.type || "application/pdf",
    };
  } else {
    // JSON body referencing a file by uri (e.g. operator/test ingestion).
    const body = (await req.json().catch(() => null)) as Partial<RawInvoice> | null;
    if (!body || !body.fileName || (!body.uri && !body.bytes)) {
      return NextResponse.json({ error: "invalid RawInvoice" }, { status: 400 });
    }
    raw = {
      fileName: body.fileName,
      source: body.source ?? "upload",
      uri: body.uri,
      bytes: body.bytes,
      mimeType: body.mimeType ?? "application/pdf",
      meta: body.meta,
    };
  }

  const result = await service.ingest(raw);
  return NextResponse.json(result, { status: 201 });
}
