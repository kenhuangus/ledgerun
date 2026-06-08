/**
 * Extract stage (FR2) — owned by the Extract/Ingestion module.
 *
 * Sends the invoice's text layer to the LLM with a STRICT JSON schema and reads
 * back structured InvoiceMetadata + ExtractedLineItem[], each field carrying its
 * own confidence and provenance (prd.md §5 FR2, §12; architecture.md §4, §6).
 *
 * Hard rule: NEVER free-text/regex parse the invoice. The LLM is the only
 * extractor; we constrain it with a schema and validate the shape on return.
 *
 * The ExtractInput contract already hands us `documentText` (ingestion runs
 * pdf-parse/OCR upstream). For callers that hold raw PDF bytes, this module also
 * exports `extractPdfText()` (pdf-parse) and an `ocrFallback()` hook (stubbed —
 * OCR is intentionally not implemented here).
 */

import type {
  ExtractStage,
  ExtractedInvoice,
  ExtractedLineItem,
  InvoiceMetadata,
  JsonSchema,
  Provenance,
  ProvenancedValue,
  StageDeps,
} from "@/contracts";

/** Prompt template version recorded into ModelInfo for reproducibility. */
const PROMPT_VERSION = "extract-v1";

/* ----------------------------- JSON schema ------------------------------ */

/**
 * Reusable schema fragment for a provenanced metadata field. `value` type is
 * supplied per-field (string | number). confidence is 0..1.
 */
function provenancedField(valueType: "string" | "number", description: string): JsonSchema {
  return {
    type: "object",
    description,
    properties: {
      value: { type: valueType },
      confidence: {
        type: "number",
        description: "0..1 confidence in THIS field's extraction.",
      },
      provenance: {
        type: "object",
        description: "Where in the document this value was read from.",
        properties: {
          sourceText: {
            type: "string",
            description: "Verbatim snippet the value was read from.",
          },
          page: { type: "number", description: "1-based page number if known." },
          locator: { type: "string", description: "Line/section/bbox locator." },
        },
      },
    },
    required: ["value", "confidence"],
  };
}

/**
 * The full Extract output schema. Every metadata field is OPTIONAL (omit if the
 * document doesn't state it) but, when present, must carry value + confidence.
 */
const EXTRACT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    metadata: {
      type: "object",
      description: "Invoice header metadata, AS WRITTEN on the invoice.",
      properties: {
        sponsorName: provenancedField("string", "Sponsor/payer name as written."),
        studyName: provenancedField("string", "Study name as written."),
        protocolNumber: provenancedField(
          "string",
          "Protocol / study number as written (highest-priority resolution signal).",
        ),
        siteName: provenancedField("string", "Site / clinic name as written."),
        invoiceNumber: provenancedField("string", "Vendor invoice number / id."),
        invoiceDate: provenancedField("string", "Issue date as ISO-8601 YYYY-MM-DD."),
        dueDate: provenancedField("string", "Due date as ISO-8601 YYYY-MM-DD."),
        currency: provenancedField("string", "ISO-4217 currency code, e.g. USD."),
        subtotal: provenancedField("number", "Stated subtotal (major units)."),
        tax: provenancedField("number", "Stated tax amount (major units)."),
        total: provenancedField("number", "Stated grand total (major units)."),
      },
    },
    lineItems: {
      type: "array",
      description: "One entry per billed line item, in document order.",
      items: {
        type: "object",
        properties: {
          rawDescription: {
            type: "string",
            description: "Line description VERBATIM from the invoice.",
          },
          quantity: { type: "number", description: "Quantity if stated." },
          unitPrice: { type: "number", description: "Unit price if stated (major units)." },
          amount: { type: "number", description: "Line total as stated (major units)." },
          confidence: {
            type: "number",
            description: "0..1 confidence in this line's extraction.",
          },
          provenance: {
            type: "object",
            properties: {
              sourceText: { type: "string" },
              page: { type: "number" },
              locator: { type: "string" },
            },
          },
        },
        required: ["rawDescription", "confidence"],
      },
    },
    overallConfidence: {
      type: "number",
      description: "0..1 overall confidence in the whole extraction.",
    },
  },
  required: ["metadata", "lineItems", "overallConfidence"],
};

/** The raw shape the LLM returns (pre-validation), mirroring EXTRACT_SCHEMA. */
interface RawExtraction {
  metadata?: Record<string, unknown>;
  lineItems?: Array<Record<string, unknown>>;
  overallConfidence?: number;
}

const SYSTEM_PROMPT = [
  "You are a meticulous accounts-payable analyst extracting structured data from a",
  "clinical-trial vendor invoice. Read ONLY what the document states — never invent",
  "values. Capture every field AS WRITTEN (do not normalize sponsor/study/site names;",
  "the downstream resolver handles canonicalization). Dates must be ISO-8601",
  "(YYYY-MM-DD). Money values are numeric major units (e.g. 1234.56), no currency",
  "symbols or thousands separators. For each field include a 0..1 confidence and, when",
  "possible, provenance (the verbatim source snippet and page). Omit any field the",
  "document does not state rather than guessing. Extract EVERY line item in order.",
  "Return your answer ONLY by calling the provided tool.",
].join(" ");

/* ------------------------------- the stage ------------------------------ */

export const extractStage: ExtractStage = async (input, deps) => {
  const log = deps.logger.child({ stage: "extract", invoiceId: input.invoiceId });

  const documentText = (input.documentText ?? "").trim();
  if (!documentText) {
    throw new Error(
      `EXTRACT_EMPTY_DOCUMENT: invoice ${input.invoiceId} (${input.fileName}) has no text layer. ` +
        "Run pdf-parse/OCR during ingestion before extraction.",
    );
  }

  const userPrompt = [
    `File name: ${input.fileName}`,
    "",
    "Invoice document text:",
    "-----BEGIN INVOICE TEXT-----",
    documentText,
    "-----END INVOICE TEXT-----",
  ].join("\n");

  log.info({ chars: documentText.length }, "calling LLM for structured extraction");

  const { value, modelInfo } = await deps.llm.completeStructured<RawExtraction>({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    schema: EXTRACT_SCHEMA,
    schemaName: "extract_invoice",
    promptVersion: PROMPT_VERSION,
  });

  const extracted = normalizeExtraction(value);
  const confidence = clamp01(
    typeof value.overallConfidence === "number"
      ? value.overallConfidence
      : deriveOverallConfidence(extracted),
  );

  log.info(
    { lineItems: extracted.lineItems.length, confidence },
    "extraction complete",
  );

  return { extracted, confidence, modelInfo };
};

export default extractStage;

/* --------------------------- normalization ------------------------------ */

/** Validate + coerce the raw LLM output into the locked contract shapes. */
function normalizeExtraction(raw: RawExtraction): ExtractedInvoice {
  return {
    metadata: normalizeMetadata(raw.metadata ?? {}),
    lineItems: Array.isArray(raw.lineItems)
      ? raw.lineItems.map(normalizeLineItem).filter((li): li is ExtractedLineItem => li !== null)
      : [],
  };
}

const STRING_META_FIELDS = [
  "sponsorName",
  "studyName",
  "protocolNumber",
  "siteName",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "currency",
] as const;

const NUMBER_META_FIELDS = ["subtotal", "tax", "total"] as const;

function normalizeMetadata(raw: Record<string, unknown>): InvoiceMetadata {
  const meta: InvoiceMetadata = {};

  for (const key of STRING_META_FIELDS) {
    const pv = normalizeProvenanced(raw[key], "string");
    if (pv) (meta as Record<string, unknown>)[key] = pv;
  }
  for (const key of NUMBER_META_FIELDS) {
    const pv = normalizeProvenanced(raw[key], "number");
    if (pv) (meta as Record<string, unknown>)[key] = pv;
  }

  return meta;
}

function normalizeProvenanced(
  raw: unknown,
  valueType: "string" | "number",
): ProvenancedValue<string | number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  let value: string | number | undefined;
  if (valueType === "string") {
    if (typeof obj.value === "string" && obj.value.trim() !== "") value = obj.value.trim();
  } else {
    const n = coerceNumber(obj.value);
    if (n !== undefined) value = n;
  }
  if (value === undefined) return undefined;

  return {
    value,
    confidence: clamp01(coerceNumber(obj.confidence) ?? 0.5),
    ...(normalizeProvenance(obj.provenance) && {
      provenance: normalizeProvenance(obj.provenance),
    }),
  };
}

function normalizeLineItem(raw: Record<string, unknown>): ExtractedLineItem | null {
  if (!raw || typeof raw !== "object") return null;
  const rawDescription =
    typeof raw.rawDescription === "string" ? raw.rawDescription.trim() : "";
  if (!rawDescription) return null;

  const item: ExtractedLineItem = {
    rawDescription,
    confidence: clamp01(coerceNumber(raw.confidence) ?? 0.5),
  };

  const quantity = coerceNumber(raw.quantity);
  if (quantity !== undefined) item.quantity = quantity;
  const unitPrice = coerceNumber(raw.unitPrice);
  if (unitPrice !== undefined) item.unitPrice = unitPrice;
  const amount = coerceNumber(raw.amount);
  if (amount !== undefined) item.amount = amount;

  const provenance = normalizeProvenance(raw.provenance);
  if (provenance) item.provenance = provenance;

  return item;
}

function normalizeProvenance(raw: unknown): Provenance | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const prov: Provenance = {};
  if (typeof obj.sourceText === "string" && obj.sourceText.trim() !== "") {
    prov.sourceText = obj.sourceText.trim();
  }
  const page = coerceNumber(obj.page);
  if (page !== undefined) prov.page = page;
  if (typeof obj.locator === "string" && obj.locator.trim() !== "") {
    prov.locator = obj.locator.trim();
  }
  return Object.keys(prov).length > 0 ? prov : undefined;
}

/** Fallback overall confidence: mean of metadata + line confidences. */
function deriveOverallConfidence(extracted: ExtractedInvoice): number {
  const confidences: number[] = [];
  for (const v of Object.values(extracted.metadata)) {
    if (v && typeof v === "object" && "confidence" in v) {
      confidences.push((v as ProvenancedValue<unknown>).confidence);
    }
  }
  for (const li of extracted.lineItems) confidences.push(li.confidence);
  if (confidences.length === 0) return 0.5;
  return confidences.reduce((a, b) => a + b, 0) / confidences.length;
}

/* ------------------------------ utilities ------------------------------- */

function coerceNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,$\s]/g, "");
    const n = Number(cleaned);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return undefined;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/* -------------------------- PDF text helpers ---------------------------- */

/**
 * Extract the text layer from raw PDF bytes. Ingestion normally does this
 * before the stage runs; re-exported here for callers that hold bytes.
 * Backed by pdfjs-dist (see src/lib/pdf.ts for why not pdf-parse).
 */
export { extractPdfText } from "@/lib/pdf";

/**
 * OCR fallback hook for image-only / scanned PDFs with no extractable text.
 * Intentionally NOT implemented — wire a real OCR engine (e.g. Tesseract /
 * Textract) here. Throws so callers don't silently get empty text.
 */
export async function ocrFallback(_pdfBytes: Buffer, fileName?: string): Promise<string> {
  throw new Error(
    `OCR_NOT_IMPLEMENTED: ${fileName ?? "document"} has no text layer and OCR is not wired up. ` +
      "Provide a text-based PDF or implement ocrFallback().",
  );
}
