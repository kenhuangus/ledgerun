"use client";

/**
 * Invoice-level QC controls (FR7): review note, correct metadata (confirm
 * resolved ids), override decision (submit/recall), rerun (from a stage), and
 * escalate. Line-level correct_match lives in <LineItems/>. Client component.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import type {
  InvoiceDetail,
  QcAction,
  StageName,
  Verdict,
} from "@/contracts";
import { applyQcAction, rerunInvoice } from "./qcClient";

const STAGES: StageName[] = ["extract", "resolve", "match", "decide"];

export function QcControls({ invoice }: { invoice: InvoiceDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      setNote("");
      setOpen(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const action = (a: QcAction) => applyQcAction(invoice.id, a);
  const currentVerdict = invoice.decision?.verdict;
  const recallTarget: Verdict = currentVerdict === "SUBMIT" ? "HOLD" : "SUBMIT";

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-gray-800">QC actions</h2>
        <p className="text-xs text-gray-500">
          The AI already decided — these correct, re-decide, or escalate after the fact. Every
          action is recorded.
        </p>
      </header>

      <div className="space-y-3 px-5 py-4">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (recorded on the action)…"
          rows={2}
          className="w-full resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
        />

        <div className="flex flex-wrap gap-2">
          <Btn
            label="Acknowledge (review)"
            busy={busy === "review"}
            onClick={() => run("review", () => action({ type: "review", note: note || undefined }))}
          />

          {invoice.resolution && (
            <Btn
              label="Confirm resolved context"
              tone="primary"
              busy={busy === "correct_metadata"}
              onClick={() =>
                run("correct_metadata", () =>
                  action({
                    type: "correct_metadata",
                    sponsorId: invoice.resolution?.sponsorId,
                    studyId: invoice.resolution?.studyId,
                    siteId: invoice.resolution?.siteId,
                    studySiteId: invoice.resolution?.studySiteId,
                    note: note || "Confirmed AI-resolved context",
                  }),
                )
              }
            />
          )}

          <Btn
            label="Rerun pipeline"
            busy={busy === "rerun-quick"}
            onClick={() => setOpen(open === "rerun" ? null : "rerun")}
          />

          {currentVerdict && (
            <Btn
              label={`Override → ${recallTarget}`}
              tone="warn"
              busy={busy === "override_decision"}
              onClick={() =>
                run("override_decision", () =>
                  action({
                    type: "override_decision",
                    verdict: recallTarget,
                    note: note || `Manual override to ${recallTarget}`,
                  }),
                )
              }
            />
          )}

          <Btn
            label="Escalate"
            tone="danger"
            busy={busy === "escalate"}
            onClick={() =>
              run("escalate", () => action({ type: "escalate", note: note || undefined }))
            }
          />
        </div>

        {open === "rerun" && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-xs font-semibold text-gray-600">Rerun from stage</p>
            <div className="flex flex-wrap gap-2">
              {STAGES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy != null}
                  onClick={() =>
                    run(`rerun-${s}`, () => rerunInvoice(invoice.id, s))
                  }
                  className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:border-sky-400 hover:bg-sky-50 disabled:opacity-50"
                >
                  {busy === `rerun-${s}` ? "…" : s}
                </button>
              ))}
              <button
                type="button"
                disabled={busy != null}
                onClick={() => run("rerun-full", () => rerunInvoice(invoice.id))}
                className="rounded-md bg-gray-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {busy === "rerun-full" ? "…" : "Full rerun"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>

      <AuditTrail actions={invoice.qcActions} />
    </div>
  );
}

function Btn({
  label,
  onClick,
  busy,
  tone = "default",
}: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "primary" | "warn" | "danger";
}) {
  const cls =
    tone === "primary"
      ? "bg-sky-600 text-white hover:bg-sky-700"
      : tone === "warn"
        ? "bg-amber-500 text-white hover:bg-amber-600"
        : tone === "danger"
          ? "border border-rose-300 text-rose-700 hover:bg-rose-50"
          : "border border-gray-300 text-gray-700 hover:bg-gray-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${cls}`}
    >
      {busy ? "…" : label}
    </button>
  );
}

function AuditTrail({ actions }: { actions: InvoiceDetail["qcActions"] }) {
  if (!actions || actions.length === 0) return null;
  return (
    <div className="border-t border-gray-100 px-5 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Action history</h3>
      <ul className="mt-2 space-y-1.5">
        {actions.map((a) => (
          <li key={a.id} className="text-xs text-gray-600">
            <span className="font-medium text-gray-900">{a.type}</span> · {a.actor} ·{" "}
            {new Date(a.createdAt).toLocaleString("en-US")}
            {a.note ? <span className="text-gray-500"> — {a.note}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
