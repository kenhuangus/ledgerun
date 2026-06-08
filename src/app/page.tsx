/**
 * Hub home — the queue (FR6). Two lanes: Submitted (FYI / trusted stream) vs.
 * Held / Exceptions (needs a reviewer). Server component: reads through the
 * InvoiceService seam, no business logic here.
 */

import { listInvoices } from "./data";
import { laneForState } from "@/components/format";
import { QueueLane } from "@/components/QueueLane";
import { IngestButton } from "@/components/IngestButton";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  let invoices = await listInvoices().catch(() => []);

  const submitted = invoices.filter((i) => laneForState(i.state) === "submitted");
  const held = invoices.filter((i) => laneForState(i.state) === "held");

  const totalExceptions = held.reduce((n, i) => n + (i.exceptionCount ?? 0), 0);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Ledger Run — Invoice Hub</h1>
          <p className="mt-1 text-sm text-gray-600">
            The AI decides first; you review after. The{" "}
            <span className="font-medium text-emerald-700">Submitted</span> lane is the trusted
            stream — ignore it. The <span className="font-medium text-amber-700">Held</span> lane is
            what needs judgment.
          </p>
        </div>
        <IngestButton />
      </header>

      <div className="mb-6 grid grid-cols-3 gap-4">
        <Stat label="Submitted" value={submitted.length} tone="emerald" />
        <Stat label="Held / exceptions" value={held.length} tone="amber" />
        <Stat label="Line-item exceptions" value={totalExceptions} tone="rose" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <QueueLane
          title="Held / Exceptions"
          accent="held"
          description="Needs you — context unresolved, unmatched/ambiguous lines, price or totals mismatch, or still in flight."
          invoices={held}
        />
        <QueueLane
          title="Submitted"
          accent="submitted"
          description="Auto-submitted by the pipeline. Auditable, but no action required."
          invoices={submitted}
        />
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "amber" | "rose";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : "text-rose-700";
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
