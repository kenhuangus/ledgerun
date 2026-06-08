/**
 * Totals reconciliation (FR6) — stated invoice total vs. the sum of line amounts.
 * Pure display; the actual reconcile verdict lives in the Decide policy. Server component.
 */
import type { InvoiceMetadata, MatchedLineItem } from "@/contracts";
import { money } from "./format";

export function TotalsReconciliation({
  metadata,
  lineItems,
}: {
  metadata?: InvoiceMetadata;
  lineItems: MatchedLineItem[];
}) {
  const currency = metadata?.currency?.value ?? "USD";
  const stated = metadata?.total?.value;
  const subtotal = metadata?.subtotal?.value;
  const tax = metadata?.tax?.value;

  const lineSum = lineItems.reduce((sum, li) => {
    const amt = li.amount ?? (li.quantity != null && li.unitPrice != null ? li.quantity * li.unitPrice : 0);
    return sum + (Number.isFinite(amt) ? amt : 0);
  }, 0);

  const diff = stated != null ? lineSum - stated : null;
  const reconciled = diff != null ? Math.abs(diff) < 0.005 : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">Totals reconciliation</h2>
      </header>
      <dl className="px-5 py-3 text-sm">
        <Row label="Sum of line amounts" value={money(lineSum, currency)} />
        {subtotal != null && <Row label="Stated subtotal" value={money(subtotal, currency)} />}
        {tax != null && <Row label="Stated tax" value={money(tax, currency)} />}
        <Row label="Stated total" value={stated != null ? money(stated, currency) : "not stated"} />
        {diff != null && (
          <div
            className={`mt-2 flex items-center justify-between rounded-lg px-3 py-2 ${
              reconciled ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"
            }`}
          >
            <dt className="text-xs font-semibold uppercase tracking-wide">
              {reconciled ? "Reconciled" : "Mismatch"}
            </dt>
            <dd className="font-mono text-sm font-semibold">
              {diff >= 0 ? "+" : ""}
              {money(diff, currency)}
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-mono text-gray-900">{value}</dd>
    </div>
  );
}
