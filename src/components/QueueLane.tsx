/** A queue lane (Submitted or Held/Exceptions) with rows. Server component. */
import Link from "next/link";
import type { InvoiceSummary } from "@/contracts";
import { Badge } from "./Badge";
import { stateBadge, verdictBadge, dateTime } from "./format";

export function QueueLane({
  title,
  accent,
  description,
  invoices,
}: {
  title: string;
  accent: "submitted" | "held";
  description: string;
  invoices: InvoiceSummary[];
}) {
  const accentRing =
    accent === "submitted"
      ? "border-emerald-200"
      : "border-amber-200";
  const accentDot = accent === "submitted" ? "bg-emerald-500" : "bg-amber-500";

  return (
    <section className={`rounded-xl border ${accentRing} bg-white shadow-sm`}>
      <header className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${accentDot}`} aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
            {title}
          </h2>
          <span className="ml-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
            {invoices.length}
          </span>
        </div>
      </header>
      <p className="px-5 pt-3 text-xs text-gray-500">{description}</p>

      <ul className="divide-y divide-gray-100 px-2 py-2">
        {invoices.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-gray-400">Nothing here.</li>
        )}
        {invoices.map((inv) => {
          const sb = stateBadge(inv.state);
          return (
            <li key={inv.id}>
              <Link
                href={`/invoices/${inv.id}`}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-3 transition hover:bg-gray-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900">{inv.fileName}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {inv.source} · {dateTime(inv.receivedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {inv.exceptionCount > 0 && (
                    <Badge className="bg-rose-100 text-rose-800 ring-rose-300">
                      {inv.exceptionCount} exception{inv.exceptionCount === 1 ? "" : "s"}
                    </Badge>
                  )}
                  {inv.verdict && (
                    <Badge className={verdictBadge(inv.verdict).className}>
                      {verdictBadge(inv.verdict).label}
                    </Badge>
                  )}
                  <Badge className={sb.className}>{sb.label}</Badge>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
