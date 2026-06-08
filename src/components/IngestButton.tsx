"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Triggers sample drop-folder ingestion via POST /api/ingest, then refreshes the queue. */
export function IngestButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ingest", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Ingest failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingest failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {error && <span className="text-xs text-rose-600">{error}</span>}
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-gray-700 disabled:opacity-50"
      >
        {busy ? "Ingesting…" : "Ingest sample invoices"}
      </button>
    </div>
  );
}
