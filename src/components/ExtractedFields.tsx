/**
 * Extracted metadata fields with per-field provenance + confidence (FR2/FR6).
 * Also shows the resolved sponsor/study/site context and any corrections.
 * Server component.
 */
import type {
  InvoiceMetadata,
  ProvenancedValue,
  ResolveOutput,
} from "@/contracts";
import { Badge } from "./Badge";
import { pct, resolutionBadge } from "./format";

type FieldKey = keyof InvoiceMetadata;

const FIELD_ORDER: Array<{ key: FieldKey; label: string }> = [
  { key: "sponsorName", label: "Sponsor" },
  { key: "studyName", label: "Study" },
  { key: "protocolNumber", label: "Protocol #" },
  { key: "siteName", label: "Site" },
  { key: "invoiceNumber", label: "Invoice #" },
  { key: "invoiceDate", label: "Invoice date" },
  { key: "dueDate", label: "Due date" },
  { key: "currency", label: "Currency" },
];

function confTone(c: number): string {
  if (c >= 0.85) return "text-emerald-700";
  if (c >= 0.6) return "text-yellow-700";
  return "text-rose-700";
}

export function ExtractedFields({
  metadata,
  resolution,
}: {
  metadata?: InvoiceMetadata;
  resolution?: ResolveOutput;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">Extracted fields</h2>
        <p className="text-xs text-gray-500">As written on the invoice — hover provenance shows the source text.</p>
      </header>

      <dl className="divide-y divide-gray-50">
        {FIELD_ORDER.map(({ key, label }) => {
          const pv = metadata?.[key] as ProvenancedValue<unknown> | undefined;
          return (
            <div key={key} className="flex items-start justify-between gap-4 px-5 py-2.5">
              <dt className="w-28 shrink-0 text-xs font-medium text-gray-500">{label}</dt>
              <dd className="min-w-0 flex-1">
                {pv ? (
                  <div className="group relative">
                    <span className="text-sm text-gray-900">{String(pv.value ?? "—")}</span>
                    <span className={`ml-2 text-xs ${confTone(pv.confidence)}`}>
                      {pct(pv.confidence)}
                    </span>
                    {pv.provenance?.sourceText && (
                      <p className="mt-0.5 truncate text-[11px] italic text-gray-400">
                        “{pv.provenance.sourceText}”
                        {pv.provenance.page ? ` · p.${pv.provenance.page}` : ""}
                      </p>
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-gray-300">not stated</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      {/* Resolved canonical context */}
      <div className="border-t border-gray-100 px-5 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Resolved context
          </h3>
          {resolution && (
            <Badge className={resolutionBadge(resolution.status).className}>
              {resolutionBadge(resolution.status).label} · {pct(resolution.confidence)}
            </Badge>
          )}
        </div>
        {resolution ? (
          <>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <Resolved label="Sponsor id" value={resolution.sponsorId} />
              <Resolved label="Study id" value={resolution.studyId} />
              <Resolved label="Site id" value={resolution.siteId} />
              <Resolved label="Study-site id" value={resolution.studySiteId} />
            </dl>
            {resolution.evidence?.corrections && resolution.evidence.corrections.length > 0 && (
              <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                <p className="text-xs font-semibold text-blue-800">Corrections applied</p>
                <ul className="mt-1 space-y-1">
                  {resolution.evidence.corrections.map((c, i) => (
                    <li key={i} className="text-xs text-blue-900">
                      <span className="font-medium">{String(c.field)}</span>:{" "}
                      <span className="line-through opacity-70">{c.statedValue ?? "—"}</span> →{" "}
                      <span className="font-semibold">{c.resolvedValue ?? "—"}</span>
                      {c.note ? <span className="text-blue-700"> — {c.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="mt-2 text-xs text-gray-400">Not resolved yet.</p>
        )}
      </div>
    </div>
  );
}

function Resolved({ label, value }: { label: string; value?: number }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-mono text-gray-900">{value ?? "—"}</dd>
    </div>
  );
}
