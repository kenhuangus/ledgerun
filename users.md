# Users — AI Email Invoice Ingestion & Matching Assistant

> Companion to [prd.md](prd.md) · [architecture.md](architecture.md) · [plan.md](plan.md)

This document describes who the system serves, what they need from it, and the jobs-to-be-done that the hub and pipeline must satisfy. The defining constraint shapes everything below: **the AI decides first; people review after.** So the human-facing design is not about *gating* work — it's about *trusting, verifying, and correcting* work that has already been done.

---

## 1. Personas

### 1.1 QC Reviewer — *primary user*
**Who:** Clinical-trial finance/operations analyst who today opens each invoice email, eyeballs it, finds the right study, and reconciles line items by hand.

**Goals**
- Stop spending time on clean, unambiguous invoices.
- Quickly understand *why* the AI held an invoice and whether it's a real problem.
- Fix the few cases the AI got wrong without fighting the tool.

**Frustrations the product removes**
- Inconsistent invoice formats and vendor terminology.
- Hunting for the correct sponsor/study/site every time.
- Re-doing matches when context was misidentified upstream.

**What they need from the hub**
- A queue that separates **submitted** (FYI) from **held / exceptions** (needs me).
- For any invoice: extracted fields, matched line items, confidence, the exact exceptions, and the submit/withhold verdict — on one screen.
- The AI's **reasoning** ("held because line 6 unit price is $480 vs. catalog $300, and 3 items unmatched"), not just a flag.
- One-click **correct → rerun** and **escalate**, with the change recorded.

**Success looks like:** they touch only the held invoices, resolve each in under a minute because the "why" is obvious, and trust the auto-submitted stream enough to leave it alone.

---

### 1.2 Operations Manager — *oversight*
**Who:** Owns invoice throughput and the exception backlog for a portfolio of studies.

**Goals**
- See that automation is actually saving time (the brief's headline metric).
- Keep the held-queue small and the auto-clear rate high without letting bad invoices through.
- Tune the precision/throughput trade-off (decision thresholds) as confidence grows.

**What they need:** the metrics in [prd.md §10](prd.md#10-success-metrics) — auto-clear rate, exception precision, time-to-decision, reviewer time — plus the ability to adjust thresholds/tolerances.

---

### 1.3 Finance / Accounts Receivable — *downstream consumer*
**Who:** Consumes the clean, matched invoice stream that gets submitted to ClinRun.

**Goals**
- Receive only invoices that are correctly attributed to sponsor/study/site and matched to catalog items.
- Trust that anything risky was held, not submitted.

**What they need:** a reliable SUBMIT stream with a decision record attached, so an auto-submitted invoice can still be audited after the fact.

---

### 1.4 Engineer / Operator — *runs and debugs the system*
**Who:** The person standing the stack up, running the demo, and diagnosing a stuck invoice.

**Goals**
- `docker compose up` → working system with sample invoices ready to process.
- When a stage fails, see exactly which stage, with what input, what error, and the retry behavior.
- Replay/rerun an invoice deterministically.

**What they need:** observable workflow state (stage timeline, status, latency, token usage, errors), structured logs, and a clear retry/recovery story ([architecture.md §7](architecture.md#7-error-handling-retry--recovery)).

---

### 1.5 The AI Agent — *system actor, not a person*
Worth naming explicitly because it's the actor that does the core work. It **extracts**, **resolves context via MCP**, **matches against the scoped catalog**, and **decides submit-vs-hold** — autonomously, before any human looks. Its obligation to the human personas is **explainability**: every action it takes is recorded with evidence and confidence so a reviewer can audit it after the fact.

---

## 2. Jobs-to-be-done (by pipeline stage)

| Stage | Job (AI) | Job (Human, post-decision) |
|---|---|---|
| **Ingest** | "When an invoice arrives, pick it up and start processing without me." | "Confirm the invoice was received and isn't stuck." |
| **Extract** | "Pull the metadata and line items into a clean structure." | "Spot-check a field if extraction looks off; correct it." |
| **Resolve context** | "Figure out the real sponsor/study/site even when the invoice says it wrong." | "Confirm a corrected attribution before it's trusted." |
| **Match** | "Match each line item to the right catalog item, or tell me it doesn't match." | "Re-point an ambiguous match; accept a low-confidence one." |
| **Decide** | "Submit it if it's clean; hold it if it's risky — and tell me why." | "Override the verdict; accept the held invoice as-is." |
| **QC / resolve** | "Re-run cleanly after a correction." | "Correct, rerun, or escalate the cases that need judgment." |

---

## 3. Post-decision QC actions (the human controls)

These are the FR7 controls, defined from the reviewer's point of view.

- **Review** — open any invoice (submitted or held) and inspect the full record: extracted fields with provenance, matched items with confidence + rationale, exceptions, totals reconciliation, and the decision record.
- **Correct metadata** — change the resolved sponsor/study/site (e.g. confirm the AI's correction on the mismatched-metadata sample). Correction is captured as an auditable event.
- **Correct a match** — re-point a line item to a different catalog item, accept a `matched_low`, or mark an item as legitimately unmatched / pass-through.
- **Override the decision** — submit a held invoice as-is, or recall/hold something the AI submitted (where the stub allows).
- **Rerun** — re-enter the pipeline from a chosen stage using corrected inputs; the AI re-decides.
- **Escalate** — flag an invoice for someone else / mark it blocked, with a note, keeping it out of the auto-submit stream.

Every action is recorded so the trail of "AI decided X → human did Y → re-decided Z" is reconstructable.

---

## 4. A day in the life (primary user)

1. Reviewer opens the hub. The queue shows **18 invoices auto-submitted overnight** and **3 held**.
2. They ignore the 18 (trusted stream) and open the first held one — `medium-invoice`. The decision panel reads: *HOLD — line 6 "Coordinator overtime" matched to catalog item but unit price $480 vs. catalog $300 (price_mismatch, +60%).* Everything else is green.
3. They confirm the invoice price is a legitimate negotiated rate, **accept the line**, and **rerun**. The AI re-decides → **SUBMIT**. ~30 seconds.
4. Next held one — `mismatched-metadata`. Panel reads: *HOLD — invoice states "Northwest Pharma / 2023" but protocol number resolves to Northwind Pharma / VERITAS; site name corrected to Harborview. (resolved_corrected, needs confirmation.)* They confirm the correction → **SUBMIT**.
5. Last one — `large-invoice` — has 3 unmatched items and an ambiguous one. They re-point the ambiguous item, mark the 3 unmatched as out-of-catalog pass-throughs, and **escalate** a question about one to the ops manager. Held until resolved.
6. Done. They spent their time only where judgment was actually required — the headline win: **time saved**.
