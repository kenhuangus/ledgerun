/** Big submit/withheld banner + the verbatim decision record (FR6). Server component. */
import type { DecisionRecord } from "@/contracts";

export function DecisionBanner({ decision }: { decision?: DecisionRecord }) {
  if (!decision) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-500 shadow-sm">
        No decision yet — the pipeline has not reached the Decide stage.
      </div>
    );
  }

  const isSubmit = decision.verdict === "SUBMIT";
  const wrap = isSubmit
    ? "border-emerald-300 bg-emerald-50"
    : "border-amber-300 bg-amber-50";
  const pill = isSubmit
    ? "bg-emerald-600 text-white"
    : "bg-amber-500 text-white";
  const heading = isSubmit ? "Submitted to ClinRun" : "Held for review";

  return (
    <div className={`rounded-xl border ${wrap} px-5 py-4 shadow-sm`}>
      <div className="flex items-center gap-3">
        <span className={`rounded-md px-2.5 py-1 text-sm font-bold tracking-wide ${pill}`}>
          {decision.verdict}
        </span>
        <div>
          <p className="text-base font-semibold text-gray-900">{heading}</p>
          <p className="text-xs text-gray-500">policy {decision.policyVersion}</p>
        </div>
      </div>

      <ol className="mt-4 space-y-2">
        {decision.reasons.map((r, i) => (
          <li
            key={`${r.code}-${i}`}
            className="rounded-lg border border-white/60 bg-white/70 px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gray-900 px-1.5 text-xs font-semibold text-white">
                {i + 1}
              </span>
              <div className="min-w-0">
                {/* Rendered verbatim so the reviewer sees exactly the AI's reasoning. */}
                <p className="text-sm text-gray-900">{r.message}</p>
                <p className="mt-0.5 font-mono text-[11px] text-gray-500">{r.code}</p>
                {r.evidence && Object.keys(r.evidence).length > 0 && (
                  <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-gray-600">
                    {Object.entries(r.evidence).map(([k, v]) => (
                      <div key={k} className="flex gap-1">
                        <dt className="font-medium text-gray-500">{k}:</dt>
                        <dd className="font-mono">{renderEvidence(v)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </div>
          </li>
        ))}
        {decision.reasons.length === 0 && (
          <li className="text-sm text-gray-500">No reasons recorded.</li>
        )}
      </ol>
    </div>
  );
}

function renderEvidence(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
