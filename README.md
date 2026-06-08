# Ledger Run — AI Email Invoice Ingestion & Matching Assistant

Ledger Run ingests clinical-trial vendor invoices, then autonomously runs them
through a four-stage pipeline — **Extract → Resolve → Match → Decide** — and lands
each invoice in a review hub with a SUBMIT or HOLD verdict and full evidence.

The pipeline runs to a decision with **no human gate before the verdict** (the
deliberate divergence from the reference README's "hard gate"; see
`architecture.md` §10). Humans act only *after*, via post-decision QC controls
(FR7).

## Architecture at a glance

- **Next.js (App Router, TypeScript strict) + Tailwind** — the review hub and thin API routes (`src/app`).
- **Pipeline** (`src/pipeline`) — `extract`, `resolve`, `match`, `decide` stages driven by a state-machine `orchestrator`. The verdict is owned by a **pure deterministic policy** (`decide.ts`), not the LLM.
- **LLM seam** (`src/llm/anthropic.ts`) — Claude behind a swappable `LlmClient` interface (structured output + tool-use loop).
- **MCP server + client** (`src/mcp-server`, `src/mcp`) — a real MCP server wrapping the read-only reference API; all canonical data is reached through it.
- **Prisma + Postgres** (`prisma/`, `src/repo`) — persistence behind `InvoiceRepo`.
- **Contracts** (`src/contracts`) — the locked seams every module imports.

## Prerequisites

- Node 20+ and npm
- Docker (for Postgres + the reference API), or your own Postgres
- An Anthropic API key (`ANTHROPIC_API_KEY`)

## Environment

Copy `.env.example` to `.env` and fill in:

| Var | Purpose |
|---|---|
| `DATABASE_URL` | App Postgres (Prisma). |
| `REFERENCE_API_URL` | Reference API base URL (default `http://localhost:8000`). Reached only via the MCP server. |
| `ANTHROPIC_API_KEY` | Claude API key. Required for the live pipeline / demo. |
| `ANTHROPIC_MODEL` | Model id (default `claude-opus-4-8`). Swappable behind `LlmClient`. |
| `MCP_TRANSPORT` | `stdio` (spawn the MCP server as a child) or in-process direct (default). |
| `DROP_FOLDER` / `UPLOAD_DIR` | Ingestion drop folder / raw blob store. |
| `POLICY_*` | Optional decision-policy threshold overrides (defaults in `src/config`). |
| `LOG_LEVEL` | pino log level. |

> Note: `claude-opus-4-8` rejects `temperature`/`top_p`. Leave `temperature` unset
> for Opus 4.8 callers (the stages already do).

## Run it

```bash
# 1. Install
npm install

# 2. Bring up Postgres + the reference API (and optionally the app) via Docker
docker compose up -d reference-db reference-api app-db
#   (or `docker compose up` to also run the mcp-server + app containers)

# 3. Generate the Prisma client and push the schema
npm run db:generate
npm run db:push

# 4. Dev server (the review hub)
npm run dev
#   open http://localhost:3000
```

In the hub, click **Ingest samples** (or POST `/api/ingest`) to pull the four
sample invoices from `reference-api/sample-invoices/` through the real pipeline.

## Tests

```bash
npm test          # vitest run — all suites
```

- `tests/decide.test.ts` — 27 unit tests over the pure decide policy (thresholds, tolerances, all four §9 scenarios).
- `tests/integration/pipeline.test.ts` — drives the **real** orchestrator + stages + decide policy against deterministic mock LLM/MCP clients and an in-memory repo (no network, no DB). Asserts the prd §9 verdict + exceptions for all four sample invoices.
- `tests/contracts.smoke.test.ts` — contract barrel smoke test.

This offline suite is the proof the wiring is correct end to end.

## Demo (live)

```bash
npm run demo
```

Ingests the four `reference-api/sample-invoices/*.pdf` through the real pipeline
and prints each invoice's verdict + exceptions. Requires `ANTHROPIC_API_KEY`, the
reference API running, and a Postgres `DATABASE_URL` with the schema pushed.

Expected behavior (prd §9):

| Sample | Verdict | Why |
|---|---|---|
| `simple-invoice.pdf` | **SUBMIT** | context `resolved_high`, all line items `matched_high`. |
| `medium-invoice.pdf` | **HOLD** | one `price_mismatch` line. |
| `large-invoice.pdf` | **HOLD** | `unmatched` + `ambiguous` + `price_mismatch` exceptions. |
| `mismatched-metadata-invoice.pdf` | **HOLD** | context `resolved_corrected` — correction needs QC confirmation. |

## Useful scripts

| Script | What |
|---|---|
| `npm run dev` | Next.js dev server. |
| `npm run build` | Production build. |
| `npm test` | Vitest. |
| `npm run demo` | Live end-to-end sample run. |
| `npm run mcp` | Run the MCP server standalone (stdio). |
| `npm run db:generate` / `npm run db:push` | Prisma client + schema push. |
| `npm run typecheck` | `tsc --noEmit`. |
