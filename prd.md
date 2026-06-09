# PRD — AI Email Invoice Ingestion & Matching Assistant

| | |
|---|---|
| **Product** | Ledger Run — AI Invoice Ingestion & Matching Assistant |
| **Tier / Version** | Silver · Version 1 (Ai-solution) |
| **Doc status** | Draft for build · authored 2026-06-08 |
| **Brief last updated** | 2026-05-17 |
| **Technical contact** | ryan.washburn@ledgerrun.com |
| **Reference repo** | https://github.com/ledgerrun/ai-takehome-test |
| **Time box** | 2–3 days |

> **Companion docs:** [users.md](users.md) · [architecture.md](architecture.md) · [plan.md](plan.md)

---

## 1. Summary

Clinical-trial site invoices arrive by email with inconsistent formatting, terminology, and structure. Triaging and matching them by hand does not scale with study volume and produces avoidable rework when context (sponsor / study / site) is misidentified or line items are mismatched.

This product is an **AI-first** workflow that ingests an invoice, interprets it, resolves its clinical-trial context, matches its line items against the correct sponsor+study catalog, and **decides on its own** whether the invoice is clean enough to submit to the ClinRun backend or should be held as an exception. Humans are **not** a gate in front of that decision. Instead, every AI decision lands in a **hub** that gives reviewers full post-decision visibility — what was extracted, what matched, where confidence was low, and whether the invoice was submitted or withheld — plus the controls to correct, rerun, or escalate when the AI got it wrong.

The goal of the build is to demonstrate **reliable end-to-end orchestration and explainable decisioning**, not perfect document intelligence.

---

## 2. Problem & context

### Business context
Manual invoice triage and matching is the bottleneck. As studies multiply, reviewers spend time on invoices that are unambiguous and clean, and the same context/line-item mistakes recur. The opportunity is to **automate intake and decisioning** to raise throughput, while keeping operational control through transparent review surfaces rather than blocking gates.

### What this is testing
Practical orchestration and explainable decision behavior — **not** state-of-the-art OCR or document AI. A strong solution shows:
- Reliable end-to-end flow across all four sample-invoice difficulty tiers.
- Robust handling of ambiguity (rewording, abbreviations, conflicting metadata).
- Clear communication of **why** the AI submitted or held each invoice.

### Core design principle (non-negotiable)
**AI completes processing first; humans review after.** The system runs extraction → context resolution → matching → decisioning end to end without a human checkpoint, then exposes the result for post-decision QC. Reviewers validate risk cases and intervene only when needed.

> **Divergence note.** The reference repo's README describes an older "hard gate" requiring human confirmation *between* metadata resolution and line-item matching. This PRD (Version 1, 2026-05-17) supersedes that: there is **no required human gate before decisioning**. The repo's reference API, seed data, and sample invoices are used as-is; only the orchestration philosophy differs. See [architecture.md §10](architecture.md#10-divergence-from-the-repo-readme).

---

## 3. Goals & non-goals

### Goals
- Ingest invoices from email and process the four provided sample invoices end to end.
- Extract metadata + line items with a real LLM (no mocked AI).
- Resolve sponsor / study / site context through the **MCP-wrapped reference API**.
- Fetch the sponsor+study-scoped catalog and match extracted line items to it.
- Make an explainable **submit-vs-hold** decision automatically.
- Surface extraction, matching, confidence/exceptions, and submit/withhold status in the hub.
- Support human QC **after** the AI decision: review, correct, rerun, escalate.
- Behave correctly across easy, ambiguous, and mismatched-metadata scenarios.

### Non-goals (for this build)
- Production-grade OCR / document intelligence. Sample invoices are text-extractable PDFs; perfect layout parsing is out of scope.
- A real ClinRun integration. No ClinRun submission API is provided; we implement a **submission stub** that records the handoff (see §7).
- OAuth email-provider connectors (Gmail/Microsoft Graph). Email ingestion is implemented via pluggable adapters — a generic `ImapSource` (real mailbox polling) and an `EmlFolderSource` (RFC822 `.eml` files, used for the offline demo/tests); provider-specific OAuth connectors are a future extension.
- Auth/SSO, multi-tenant RBAC, billing. Single trusted operator context is assumed.
- Learning/feedback loops that retrain models from QC corrections.

---

## 4. Users

Summarized here; full personas and stories in [users.md](users.md).

| Persona | Role in the flow |
|---|---|
| **QC Reviewer** (primary) | Reviews AI decisions in the hub, validates held/low-confidence invoices, corrects and reruns. |
| **Operations Manager** | Watches throughput and exception rate; cares about time saved. |
| **Finance / AR** | Consumes the clean stream submitted to ClinRun. |
| **Engineer / Operator** | Runs the stack, observes workflow state, debugs failures. |
| **The AI agent** (system actor) | Performs extraction, resolution, matching, and decisioning autonomously. |

---

## 5. Functional requirements

Each requirement is verifiable and traced to acceptance in §9 and to milestones in [plan.md](plan.md).

| ID | Requirement | Notes |
|---|---|---|
| **FR1** | **Email ingestion + sample processing.** Accept invoices from an email source via a pluggable adapter, and process all four provided sample invoices end to end. | Adapter abstracts the inbox; a drop-folder/upload path covers the samples. |
| **FR2** | **LLM extraction.** Extract invoice metadata (sponsor, study/protocol, site, invoice no., dates, currency, totals) and line items (description, qty, unit price, amount) using a real LLM into a validated schema. | Structured output; per-field provenance. |
| **FR3** | **Context resolution via MCP.** Resolve sponsor → study → site → study-site against the reference API, accessed **only** through the MCP server. Support exact, fuzzy, and AI-assisted resolution. | Must reconcile conflicting metadata signals (name vs. protocol). |
| **FR4** | **Scoped catalog matching.** Fetch the catalog scoped to the confirmed `sponsor_id` + `study_id` and match each extracted line item to a catalog item (or none), with confidence + rationale. | Handles rewording, abbreviations, ~100-item catalogs. |
| **FR5** | **AI submit-vs-hold decision.** Decide automatically whether to submit the invoice to the ClinRun backend (stub) or hold it as an exception, with an explainable decision record. | Deterministic policy over LLM/match signals (§6). |
| **FR6** | **Hub visibility.** Show, per invoice: what was extracted, what matched (and to what), confidence and exceptions, and whether it was **submitted or withheld**. | Plus current workflow state and stage timeline. |
| **FR7** | **Post-decision QC actions.** Let a reviewer review, correct (metadata, matches, decision), and **rerun or escalate** an invoice after the AI has decided. | Corrections are auditable; rerun re-enters the pipeline. |
| **FR8** | **Scenario coverage.** Demonstrate correct behavior across easy, ambiguous, and mismatched-metadata scenarios using the provided samples. | Mapped to the 4 sample PDFs in §9. |

---

## 6. Decision model (submit vs. hold)

The AI decision is a **deterministic policy over scored signals**, so it is explainable and testable. The LLM produces candidates + confidence + rationale; the policy turns those into a verdict.

### Line-item match outcomes
| Outcome | Condition | Effect on invoice decision |
|---|---|---|
| `matched_high` | Single best catalog candidate, confidence ≥ **0.85**, price within tolerance | Clean |
| `matched_low` | Best candidate confidence **0.60–0.85** | Flag for QC; does not block on its own |
| `ambiguous` | Top candidates within a small margin of each other | Exception |
| `unmatched` | No candidate ≥ **0.60** | Exception |
| `price_mismatch` | Matched to a catalog item, but extracted unit price/amount deviates beyond tolerance (default **±2%** or **±$25**, whichever is larger) | Exception |

### Context resolution outcomes
`resolved_high` (unique, confident), `resolved_corrected` (resolved after reconciling conflicting metadata — e.g. protocol number overrides a wrong sponsor name), `ambiguous` (multiple candidates), `unresolved`.

### Invoice-level verdict
**HOLD** if *any* of: context is `ambiguous`/`unresolved`; one or more `price_mismatch`, `unmatched`, or `ambiguous` line items; invoice total does not reconcile with the sum of line amounts beyond tolerance.

**SUBMIT** if: context `resolved_high` or `resolved_corrected` with confidence above threshold; all line items `matched_high` (or `matched_low` within an allowed count, configurable, default 0 for auto-submit); totals reconcile.

Every verdict is stored as a **decision record**: verdict, the ranked list of triggering reasons, per-item evidence, model + prompt version, and confidence scores. The hub renders this verbatim so a reviewer can see *why*.

> Thresholds and tolerances are configuration, not hard-coded, so reviewers/operators can tune precision vs. throughput.

---

## 7. ClinRun submission (stub)

No ClinRun API is provided in the take-home. We model the downstream handoff with a **submission sink**: on a SUBMIT verdict the system writes a `Submission` record (payload = normalized invoice + matched catalog references + decision record) to a local endpoint/queue and marks the invoice `SUBMITTED`. The interface is isolated behind a `ClinRunClient` so a real endpoint can drop in later. HELD invoices are never submitted; they wait in the exception queue for QC.

---

## 8. Non-functional requirements & performance benchmarks

| ID | Requirement |
|---|---|
| **NFR1** | **Stable end-to-end processing** on simple, medium, large, and mismatched-metadata samples — no workflow crashes. |
| **NFR2** | **Large-catalog matching** (~100 items for one sponsor+study) completes without failure; matching uses retrieval/shortlisting so the prompt stays bounded. |
| **NFR3** | **Responsive hub** for core read/review actions (list, open, inspect a decision) — interactions feel immediate on local hardware. |
| **NFR4** | **Predictable retry/recovery.** Any stage that fails or returns a low-confidence result has defined retry and fallback behavior; the invoice never silently disappears. |
| **NFR5** | **Observable state.** Every stage transition is recorded (status, timing, inputs/outputs, errors, token usage) and visible for debugging and demo. |
| **NFR6** | **Modular staged architecture** with clear separation of extraction / matching / decisioning, each independently testable. |
| **NFR7** | **Reproducible.** One `docker compose up` brings up the reference API + app; sample invoices are processable out of the box. |

---

## 9. Acceptance scenarios (provided samples)

The four sample PDFs in `sample-invoices/` are the acceptance fixtures. Expected behavior:

| Sample | Context | Line items | Expected AI behavior |
|---|---|---|---|
| `simple-invoice.pdf` | Contoso Therapeutics / CATALYST Trial (`CON-CAT-2024-101`) | 5, light wording variation | Context `resolved_high`; all items `matched_high`; **SUBMIT** with no exceptions. |
| `medium-invoice.pdf` | Northwind Pharma / LUMIN-2024 | 11, includes one price mismatch | Context resolved; 10 clean, 1 `price_mismatch`; **HOLD** with the mismatch surfaced; QC can accept/correct and rerun → SUBMIT. |
| `large-invoice.pdf` | Northwind Pharma / LUMIN-2024 | 27, heavy rewording + abbreviations, ambiguous items, 1 price mismatch, 3 unmatched | Context resolved; the price mismatch, ambiguous, and 3 unmatched items become exceptions; **HOLD**; matching stays stable on the ~large catalog (NFR2). |
| `mismatched-metadata-invoice.pdf` | Northwind Pharma / VERITAS, but invoice metadata is wrong (sponsor name, protocol year, site name) | 7 | System detects the metadata conflict, reconciles to the correct entities (e.g. via protocol number) as `resolved_corrected`, and **HOLDS** for QC confirmation of the correction; reviewer confirms → SUBMIT. |

**Definition of done:** all four run end to end, land in the hub with correct extracted/matched/exception/decision data, and the QC actions in FR7 work on at least the held cases.

---

## 10. Success metrics

Primary impact metric from the brief: **time saved**.

| Metric | Definition | Target signal |
|---|---|---|
| **Auto-clear rate** | % of invoices the AI submits without any QC touch | High on simple/clean invoices (e.g. simple-invoice auto-submits) |
| **Exception precision** | Of invoices held, % that genuinely needed a human | Held cases map to real mismatches/ambiguity, not noise |
| **Time-to-decision** | Ingest → AI verdict, per invoice | Seconds, not minutes; bounded on large catalog |
| **Reviewer time per invoice** | Hub interaction time on held cases | Low — decision record makes the "why" obvious at a glance |
| **End-to-end reliability** | % of sample runs with no workflow failure | 100% across the four samples |

---

## 11. Scope summary

**In scope:** ingestion adapter + sample processing, LLM extraction, MCP-mediated context resolution, scoped catalog matching, automatic submit/hold decisioning, the hub (visibility + QC actions), observability, retry/recovery, Docker Compose, tests for core + exception paths.

**Out of scope:** production OCR, real ClinRun & email-provider integrations, auth/RBAC, model fine-tuning, analytics dashboards beyond the basic metrics above.

---

## 12. Assumptions & open questions

1. **Authoritative philosophy = AI-first** (brief overrides README's hard gate). Confirmed for this build.
2. **ClinRun is stubbed** — there is no provided submission endpoint. Confirm the expected payload shape if a real one exists.
3. **Sample PDFs are text-extractable**; if any require true OCR, an OCR fallback (e.g. Tesseract) is added behind the extraction adapter.
4. **Single-currency, single-operator** context for v1.
5. **Conflict-resolution priority** for mismatched metadata defaults to: protocol/study number > study name > sponsor name > site name. Tunable.
6. **LLM provider** defaults to Claude (Anthropic) via the staged orchestrator; swappable behind an LLM-client interface.
