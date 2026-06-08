/**
 * Invoice detail (FR6 + FR7). One screen: submit/withheld banner + verbatim
 * decision record, extracted fields with provenance, resolved context,
 * matched line items, exceptions, totals reconciliation, the stage timeline,
 * and the QC controls. Server component; interactive bits are client islands.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import { getInvoice } from "../../data";
import { Badge } from "@/components/Badge";
import { stateBadge, dateTime } from "@/components/format";
import { DecisionBanner } from "@/components/DecisionBanner";
import { ExtractedFields } from "@/components/ExtractedFields";
import { LineItems } from "@/components/LineItems";
import { ExceptionsList } from "@/components/ExceptionsList";
import { TotalsReconciliation } from "@/components/TotalsReconciliation";
import { StageTimeline } from "@/components/StageTimeline";
import { QcControls } from "@/components/QcControls";

export const dynamic = "force-dynamic";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const invoice = await getInvoice(id).catch(() => null);
  if (!invoice) notFound();

  const currency = invoice.metadata?.currency?.value ?? "USD";
  const sb = stateBadge(invoice.state);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <nav className="mb-4 text-sm">
        <Link href="/" className="text-sky-700 hover:underline">
          ← Queue
        </Link>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{invoice.fileName}</h1>
          <p className="mt-1 text-xs text-gray-500">
            {invoice.source} · received {dateTime(invoice.receivedAt)} ·{" "}
            <span className="font-mono">{invoice.id}</span>
          </p>
        </div>
        <Badge className={sb.className}>{sb.label}</Badge>
      </header>

      {/* Decision first — it's the headline "why". */}
      <div className="mb-6">
        <DecisionBanner decision={invoice.decision} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <LineItems invoiceId={invoice.id} items={invoice.lineItems} currency={currency} />
          <ExceptionsList items={invoice.lineItems} currency={currency} />
        </div>

        <div className="space-y-6">
          <ExtractedFields metadata={invoice.metadata} resolution={invoice.resolution} />
          <TotalsReconciliation metadata={invoice.metadata} lineItems={invoice.lineItems} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <QcControls invoice={invoice} />
        </div>
        <div>
          <StageTimeline events={invoice.events} />
        </div>
      </div>
    </main>
  );
}
