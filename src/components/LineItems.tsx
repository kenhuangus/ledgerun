"use client";

/**
 * Matched line items table (FR6) + inline per-line QC controls (FR7 correct_match):
 * re-point to another catalog candidate, accept a matched_low, or mark a line as
 * legitimately unmatched / pass-through. Client component.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { MatchedLineItem } from "@/contracts";
import { Badge } from "./Badge";
import { pct, money, outcomeBadge, isException } from "./format";
import { applyQcAction } from "./qcClient";

export function LineItems({
  invoiceId,
  items,
  currency,
}: {
  invoiceId: string;
  items: MatchedLineItem[];
  currency: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">Line items</h2>
        <p className="text-xs text-gray-500">
          {items.length} line{items.length === 1 ? "" : "s"} · catalog target, confidence, and the
          AI rationale per line.
        </p>
      </header>
      <ul className="divide-y divide-gray-100">
        {items.length === 0 && (
          <li className="px-5 py-6 text-sm text-gray-400">No line items.</li>
        )}
        {items.map((li) => (
          <LineRow key={li.index} invoiceId={invoiceId} item={li} currency={currency} />
        ))}
      </ul>
    </div>
  );
}

function LineRow({
  invoiceId,
  item,
  currency,
}: {
  invoiceId: string;
  item: MatchedLineItem;
  currency: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const ob = outcomeBadge(item.outcome);
  const exception = isException(item.outcome);
  const matched = item.candidates?.find((c) => c.catalogItemId === item.matchedItemId);

  async function act(payload: Parameters<typeof correctMatch>[0]) {
    setBusy(true);
    setError(null);
    try {
      await correctMatch(payload);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function correctMatch(payload: {
    matchedItemId?: number | null;
    accept?: boolean;
    note?: string;
  }) {
    await applyQcAction(invoiceId, {
      type: "correct_match",
      lineItemIndex: item.index,
      ...payload,
    });
  }

  const lineAmount =
    item.amount ??
    (item.quantity != null && item.unitPrice != null ? item.quantity * item.unitPrice : undefined);

  return (
    <li className={`px-5 py-3 ${exception ? "bg-amber-50/40" : ""}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">
            <span className="mr-2 font-mono text-xs text-gray-400">#{item.index + 1}</span>
            {item.rawDescription}
          </p>
          <p className="mt-0.5 text-xs text-gray-500">
            qty {item.quantity ?? "—"} · unit {money(item.unitPrice, currency)} ·{" "}
            <span className="font-medium">{money(lineAmount, currency)}</span> · extract conf{" "}
            {pct(item.confidence)}
          </p>

          {/* catalog target */}
          <div className="mt-1.5 text-xs">
            {item.matchedItemId != null ? (
              <span className="text-gray-700">
                → catalog{" "}
                <span className="font-mono">
                  {matched?.itemCode ? `${matched.itemCode}` : `#${item.matchedItemId}`}
                </span>
                {matched?.description ? ` · ${matched.description}` : ""}
                {matched?.catalogUnitPrice != null && (
                  <span className="text-gray-500"> @ {money(matched.catalogUnitPrice, currency)}</span>
                )}
                {item.matchConfidence != null && (
                  <span className="ml-1 text-gray-500">({pct(item.matchConfidence)})</span>
                )}
              </span>
            ) : (
              <span className="text-gray-400">no catalog target</span>
            )}
          </div>

          {item.rationale && (
            <p className="mt-1 text-xs italic text-gray-500">“{item.rationale}”</p>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Badge className={ob.className}>{ob.label}</Badge>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium text-sky-700 hover:underline"
          >
            {open ? "Close" : "Correct"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold text-gray-600">Re-point this line</p>
          <div className="flex flex-wrap gap-2">
            {(item.candidates ?? []).map((c) => {
              const active = c.catalogItemId === item.matchedItemId;
              return (
                <button
                  key={c.catalogItemId}
                  type="button"
                  disabled={busy}
                  onClick={() => act({ matchedItemId: c.catalogItemId })}
                  className={`rounded-md border px-2.5 py-1.5 text-left text-xs transition disabled:opacity-50 ${
                    active
                      ? "border-emerald-400 bg-emerald-50"
                      : "border-gray-200 hover:border-sky-400 hover:bg-sky-50"
                  }`}
                >
                  <span className="font-mono">{c.itemCode}</span> · {c.description}
                  <span className="block text-gray-400">
                    {money(c.catalogUnitPrice, currency)} · {pct(c.confidence)}
                  </span>
                </button>
              );
            })}
            {(item.candidates ?? []).length === 0 && (
              <span className="text-xs text-gray-400">No alternate candidates were considered.</span>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {item.outcome === "matched_low" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => act({ accept: true })}
                className="rounded-md bg-emerald-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Accept low-confidence match
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => act({ matchedItemId: null, note: "Marked pass-through / out-of-catalog" })}
              className="rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Mark unmatched / pass-through
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        </div>
      )}
    </li>
  );
}
