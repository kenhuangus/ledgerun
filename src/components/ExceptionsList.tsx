/** Compact list of the line-item exceptions (FR6). Server component. */
import type { MatchedLineItem } from "@/contracts";
import { Badge } from "./Badge";
import { outcomeBadge, isException, money } from "./format";

export function ExceptionsList({
  items,
  currency,
}: {
  items: MatchedLineItem[];
  currency: string;
}) {
  const exceptions = items.filter((li) => isException(li.outcome));
  if (exceptions.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-sm text-emerald-800 shadow-sm">
        No line-item exceptions — every line matched cleanly.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-white shadow-sm">
      <header className="border-b border-amber-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">
          Exceptions <span className="text-amber-700">({exceptions.length})</span>
        </h2>
      </header>
      <ul className="divide-y divide-gray-100">
        {exceptions.map((li) => (
          <li key={li.index} className="flex items-start justify-between gap-3 px-5 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm text-gray-900">
                <span className="mr-1.5 font-mono text-xs text-gray-400">#{li.index + 1}</span>
                {li.rawDescription}
              </p>
              <p className="text-xs text-gray-500">
                {money(li.amount ?? (li.unitPrice ?? 0) * (li.quantity ?? 0), currency)}
              </p>
            </div>
            <Badge className={outcomeBadge(li.outcome).className}>
              {outcomeBadge(li.outcome).label}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
