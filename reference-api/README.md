# Take-Home: AI Invoice Ingestion Platform

## Background

We process invoices from **clinical trial sites** that need to be paid by sponsors for their studies. A user uploads a site invoice (PDF or image), and the system needs to:

1. **Extract** structured data from the document using AI — pull out metadata (site, sponsor, study/protocol) and the individual line items (descriptions, quantities, amounts).
2. **Present metadata for user confirmation** — show the user what was extracted and what entities it matched to in the system. The user must confirm (or correct) the metadata before anything else happens.
3. **Match line items** — once the user confirms the metadata, we know the context (which sponsor and study). That context determines which catalog of valid line items applies. Use AI to compare each extracted line item against that scoped catalog and suggest the best match (or flag it as unmatched).
4. **Present line-item matches for review** — show the user the suggested matches and let them review before finalizing.

The key insight: the pipeline is not fully automated. The user is a gate between metadata confirmation and line-item matching. You can't match line items until the user confirms the context, because the context determines what catalog to match against.

---

## Reference Data API (Provided)

This repo includes a **Docker Compose** stack that runs a **Postgres** database and a **FastAPI** read-only API. Your pipeline will call this API to look up sponsors, studies, sites, study-site associations, and **line-item catalogs** (scoped by sponsor + study).

### Getting Started

1. **Start the reference API**

   ```bash
   docker compose up --build
   ```

   - Postgres listens on `localhost:5433` (user `ctref`, password `ctref`, database `ctref`). Port 5433 is used to avoid conflicting with a local Postgres on 5432.
   - The API runs at **http://localhost:8000**. It waits for the database to be ready, seeds it, then starts.
   - Interactive API docs: **http://localhost:8000/docs**

2. **Optional: Regenerate sample invoice PDFs**

   Sample PDFs are in `sample-invoices/`. To regenerate them:

   ```bash
   pip install reportlab
   python scripts/generate_sample_invoices.py
   ```

### API Endpoints

Interactive API docs (Swagger UI) are at **http://localhost:8000/docs**. All data endpoints are read-only and return JSON. Pagination is supported via `page` and `page_size` query parameters (default `page_size=50`, max 100 or 200 for catalog-items).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (returns `{"status": "ok"}`) |
| GET | `/api/v1/sponsors` | List all sponsors |
| GET | `/api/v1/sponsors/{id}` | Get one sponsor |
| GET | `/api/v1/studies` | List studies (optional `?sponsor_id=` filter) |
| GET | `/api/v1/studies/{id}` | Get one study |
| GET | `/api/v1/sites` | List all sites |
| GET | `/api/v1/sites/{id}` | Get one site |
| GET | `/api/v1/study-sites` | List study-site links (optional `?study_id=`, `?site_id=`) |
| GET | `/api/v1/study-sites/{id}` | Get one study-site |
| GET | `/api/v1/catalog-items` | List catalog items (optional `?sponsor_id=`, `?study_id=`) |
| GET | `/api/v1/catalog-items/{id}` | Get one catalog item |

**List responses** are paginated:

```json
{
  "items": [ ... ],
  "total": 42,
  "page": 1,
  "page_size": 50,
  "pages": 1
}
```

**Single-entity response** (e.g. `GET /api/v1/sponsors/1`):

```json
{
  "id": 1,
  "name": "Northwind Pharma",
  "code": "NWD"
}
```

**Example: Get catalog for a sponsor + study (for line-item matching)**

```bash
curl "http://localhost:8000/api/v1/catalog-items?sponsor_id=1&study_id=1"
```

One sponsor+study combination (Northwind Pharma / LUMIN-2024) has a **large catalog (~100 items)** so you can test how your pipeline handles latency when matching against many options.

### Seed Data Overview

- **Sponsors** (fictional): Northwind Pharma, Contoso Therapeutics, Fabrikam Biopharma, Woodgrove Life Sciences.
- **Studies**: e.g. LUMIN-2024, VERITAS, CATALYST Trial, AURORA Extension, SUMMIT Study, FOUNDATION Registry — each has a protocol number and therapeutic area.
- **Sites**: e.g. Willow Creek Clinical Research Center, Harborview Medical Institute, Highland Ridge Hospital — with city, state, country, and PI name.
- **Study-sites**: which sites participate in which studies (for context/validation).
- **Catalog items**: valid billable line items per sponsor+study (patient visits, procedures, lab/imaging, administrative, pass-through). Categories include `patient_visits`, `procedures`, `lab_imaging`, `administrative`, `pass_through`.

### Sample Invoices

In `sample-invoices/`. Each PDF includes an **invoice number** and **invoice date** for extraction testing. The three invoices form a **difficulty gradient** so you can exercise AI matching and human-review flows:

- **simple-invoice.pdf** — 5 line items; **Contoso Therapeutics / CATALYST Trial** (protocol CON-CAT-2024-101), smaller catalog. **Easy**: mostly straightforward matches with light wording variation (e.g. "Site Management Fee" vs catalog "Site Fee", "Complete Blood Count" vs "CBC"). Happy path.
- **medium-invoice.pdf** — 11 line items; Northwind Pharma / LUMIN-2024. **Medium**: mix of exact and fuzzy descriptions; one **price mismatch** (e.g. IRB line at $550 vs catalog $500) so human review is needed.
- **large-invoice.pdf** — 27 line items; Northwind Pharma / LUMIN-2024. **Hard**: heavy rewording and abbreviations, **ambiguous** line items (multiple possible catalog matches), one **price mismatch** (e.g. CT scan), and **3 unmatched items** (not in the catalog: e.g. parking reimbursement, patient stipend, translator services) that should be flagged for human review.
- **mismatched-metadata-invoice.pdf** — 7 line items; targets Northwind Pharma / VERITAS, but the **metadata on the invoice is wrong**: the sponsor name is slightly off ("Northwind Pharmaceuticals Inc." vs "Northwind Pharma"), the protocol number has the wrong year, and the site name doesn't exactly match any seeded site. This forces the user to **manually select or correct metadata** before the pipeline can proceed -- testing the "metadata not found" path.

Site names on the first three invoices match seeded sites. The mismatched-metadata invoice deliberately uses names that don't match cleanly.

---

## What to Build

Build an end-to-end AI-powered invoice ingestion pipeline that uses the **reference API above** for metadata and catalog data. Your application can be in any language/framework and may run in the same Docker Compose or separately; the flow must hit these four stages:

### Stage 1: Upload and Extract

- Accept an invoice file (PDF or image).
- Use a **real LLM** (OpenAI, Anthropic, or equivalent) to extract structured data: **metadata** (site, sponsor, study/protocol) and **line items** (description, quantity, unit price, amount).
- Persist what was extracted.

### Stage 2: Present Metadata and Wait for User Confirmation

- Match the extracted metadata to entities in the system by **calling the reference API** (sponsors, studies, sites, study-sites). Matching can be exact, fuzzy, or AI-assisted — your call.
- Present the extracted metadata and suggested matches to the user.
- The user must **confirm or correct** the metadata before the pipeline proceeds. This is a **hard gate** — line-item matching does not run until the user says the metadata is right.
- If you cannot match a field (e.g. vendor not found), the user must be able to select the correct entity manually.

### Stage 3: Match Line Items

- Only after the user confirms metadata does this step run.
- Use the **confirmed sponsor + study** to fetch the scoped catalog: `GET /api/v1/catalog-items?sponsor_id=...&study_id=...`.
- Use the LLM to compare each extracted line-item description to that catalog and suggest the best match (or mark as unmatched).
- Persist the match results alongside the extracted data.

### Stage 4: Present Line-Item Matches for Review

- Show each extracted line item with its suggested catalog match.
- Make unmatched items clearly visible.
- Provide a way to finalize/submit the invoice once the user is satisfied.

## Requirements

- **Real AI** — Use a real LLM API for extraction and for line-item matching. No mock AI.
- **Human-in-the-loop** — The user must confirm metadata before line-item matching runs.
- **Staged flow** — Metadata extraction and matching first; only after user confirmation does line-item matching run, scoped by the confirmed sponsor+study.
- **Use the reference API** — Query the provided Docker Compose API for sponsors, studies, sites, and catalog items. Store your own extracted data, match results, and any app state in a DB of your choice (SQLite, Postgres, etc.).
- **Separation** — Keep extraction, metadata matching, and line-item matching as distinct steps or services.
- **Sample data** — Use the provided sample invoice PDFs and the seeded reference data to run your pipeline end to end.

## Deliverables

1. **Code** — Push to a GitHub repo. Language and framework are your choice.
2. **README** — How to run the reference API and your app, what env vars are needed (e.g. API keys), and how to exercise the full flow.
3. **Short write-up** (can be in the README):
   - How you designed the extraction and matching prompts.
   - How you handled the case where metadata matching partially fails (e.g. sponsor not found but study matched).
   - One thing you would improve or add next.
