/**
 * Match stage (FR4). Owned by Stream C.
 *
 * Fetches the catalog scoped to the resolved sponsorId + studyId via MCP, then
 * for each extracted line item:
 *   1. SHORTLISTS candidates with a lexical/normalized pre-filter so the LLM
 *      prompt stays bounded even on a ~100-item catalog (NFR2).
 *   2. Asks Claude (structured output) to pick the best candidate with a
 *      confidence + rationale + ranked alternates.
 *   3. Classifies the MatchOutcome using the PolicyConfig confidence thresholds
 *      and price tolerances (prd.md §6, incl. price_mismatch).
 *
 * The verdict (SUBMIT/HOLD) is NOT made here — Decide owns it. This stage only
 * produces per-line outcomes + evidence. See architecture.md §4, §6.
 */

import type {
  MatchStage,
  MatchInput,
  MatchOutput,
  MatchedLineItem,
  MatchCandidate,
  ExtractedLineItem,
  CatalogItem,
  McpClient,
  RefId,
  PolicyConfig,
  Logger,
} from "@/contracts";
import type { MatchOutcome } from "@/contracts";

const PROMPT_VERSION = "match-v1";

/** Catalog page size — the reference API caps catalog-items at 200. */
const CATALOG_PAGE_SIZE = 200;
/** Hard safety bound on pages fetched (defensive against a runaway `pages`). */
const MAX_CATALOG_PAGES = 25;
/** How many shortlisted candidates we put in front of the LLM per line item (large catalogs). */
const SHORTLIST_SIZE = 12;
/**
 * If the scoped catalog has at most this many items, skip lexical pre-filtering
 * entirely and let the LLM see the WHOLE catalog. The shortlist exists only to
 * bound the prompt on large catalogs (NFR2); on small catalogs pre-filtering
 * just risks dropping acronym/synonym matches whose tokens don't overlap the
 * line text (e.g. "Complete Blood Count" -> catalog "CBC").
 */
const SHORTLIST_FULL_THRESHOLD = 50;
/**
 * Margin (in confidence units) within which the top-2 candidates are treated as
 * `ambiguous` rather than a clean match.
 */
const AMBIGUITY_MARGIN = 0.1;

/* --------------------------- Catalog fetch ------------------------------ */

/**
 * Fetch the FULL scoped catalog (all pages) for sponsorId+studyId. The shortlist
 * pre-filter runs client-side over this list, so we want the complete catalog in
 * memory. Bounded by MAX_CATALOG_PAGES for safety.
 */
async function fetchScopedCatalog(
  mcp: McpClient,
  sponsorId: RefId,
  studyId: RefId,
  logger: Logger,
): Promise<CatalogItem[]> {
  const all: CatalogItem[] = [];
  let page = 1;
  let pages = 1;
  do {
    const res = await mcp.searchCatalogItems({
      sponsorId,
      studyId,
      page,
      pageSize: CATALOG_PAGE_SIZE,
    });
    all.push(...res.items);
    pages = Number.isFinite(res.pages) && res.pages > 0 ? res.pages : 1;
    page += 1;
  } while (page <= pages && page <= MAX_CATALOG_PAGES);

  logger.info({ sponsorId, studyId, catalogSize: all.length, pages }, "match: catalog fetched");
  return all;
}

/* --------------------------- Shortlisting ------------------------------- */

/** Normalize text for lexical comparison: lowercase, strip punctuation, collapse ws. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  const n = normalize(s);
  return n.length === 0 ? [] : n.split(" ").filter((t) => t.length > 1);
}

/**
 * Lexical shortlist score between a line description and a catalog item. Combines
 * token-overlap (Jaccard-ish, weighted by recall on the line tokens), an exact
 * item-code hit, and a substring bonus. Cheap, deterministic, language-agnostic
 * enough for rewording/abbreviation tiers. Keeps the LLM prompt bounded (NFR2).
 */
function shortlistScore(line: ExtractedLineItem, item: CatalogItem): number {
  const lineTokens = new Set(tokenize(line.rawDescription));
  if (lineTokens.size === 0) return 0;

  const itemText = `${item.itemCode ?? ""} ${item.description ?? ""}`;
  const itemTokens = new Set(tokenize(itemText));
  if (itemTokens.size === 0) return 0;

  let overlap = 0;
  for (const t of lineTokens) if (itemTokens.has(t)) overlap += 1;

  // Recall over the (shorter) line tokens — rewards items that cover the line's words.
  const recall = overlap / lineTokens.size;
  // Precision-ish over item tokens — penalizes huge generic descriptions slightly.
  const union = new Set([...lineTokens, ...itemTokens]).size;
  const jaccard = overlap / union;

  let score = 0.7 * recall + 0.3 * jaccard;

  // Exact item-code mention in the raw description is a very strong signal.
  const normLine = normalize(line.rawDescription);
  const normCode = normalize(item.itemCode ?? "");
  if (normCode.length >= 3 && normLine.includes(normCode)) {
    score = Math.min(1, score + 0.5);
  }
  // Whole-description substring containment bonus.
  const normDesc = normalize(item.description ?? "");
  if (normDesc.length >= 4 && (normLine.includes(normDesc) || normDesc.includes(normLine))) {
    score = Math.min(1, score + 0.2);
  }

  return score;
}

/** Top-N catalog items for a line, by lexical score (ties broken by item id). */
function shortlist(line: ExtractedLineItem, catalog: CatalogItem[], n: number): CatalogItem[] {
  return catalog
    .map((item) => ({ item, score: shortlistScore(line, item) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.item.id - b.item.id)
    .slice(0, n)
    .map((c) => c.item);
}

/* --------------------------- LLM pick schema ---------------------------- */

const PICK_SCHEMA = {
  type: "object",
  properties: {
    catalogItemId: {
      type: ["number", "null"],
      description: "The id of the best-matching catalog candidate, or null if NONE genuinely matches.",
    },
    confidence: {
      type: "number",
      description: "0..1 confidence that catalogItemId is the correct match for this line item.",
    },
    rationale: {
      type: "string",
      description: "One concise sentence on why this candidate matches (or why none does).",
    },
    alternates: {
      type: "array",
      description: "Other plausible candidate ids, ranked, with their own confidence.",
      items: {
        type: "object",
        properties: {
          catalogItemId: { type: "number" },
          confidence: { type: "number" },
        },
        required: ["catalogItemId", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["catalogItemId", "confidence", "rationale"],
  additionalProperties: false,
} as const;

interface PickResult {
  catalogItemId: number | null;
  confidence: number;
  rationale: string;
  alternates?: Array<{ catalogItemId: number; confidence: number }>;
}

const SYSTEM_PROMPT = [
  "You are the line-item matching stage of an autonomous clinical-trial invoice pipeline.",
  "You are given ONE invoice line item and a SHORTLIST of candidate catalog items (already scoped to the correct sponsor+study).",
  "Pick the single catalog item that best matches the line, accounting for rewording, abbreviations, and clinical synonyms.",
  "Return null for catalogItemId if NONE of the candidates is genuinely the same billable item — do not force a weak match.",
  "Judge match quality on the DESCRIPTION/semantics only. Do NOT lower confidence for price differences — price reconciliation is handled deterministically downstream.",
  "Confidence must reflect how certain you are the chosen item is the same line: 1.0 = certain, ~0.7 = probable, <0.6 = weak.",
].join(" ");

function buildLinePrompt(line: ExtractedLineItem, candidates: CatalogItem[]): string {
  const cand = candidates
    .map(
      (c, i) =>
        `${i + 1}. id=${c.id} | code=${c.itemCode} | ${c.description}` +
        (c.category ? ` | category=${c.category}` : "") +
        (c.unitPrice != null ? ` | catalogUnitPrice=${c.unitPrice}` : ""),
    )
    .join("\n");

  const lineFacts = [
    `Description: "${line.rawDescription}"`,
    line.quantity != null ? `Quantity: ${line.quantity}` : null,
    line.unitPrice != null ? `Unit price (as billed): ${line.unitPrice}` : null,
    line.amount != null ? `Line amount (as billed): ${line.amount}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    "INVOICE LINE ITEM:",
    lineFacts,
    "",
    "CANDIDATE CATALOG ITEMS (shortlist):",
    cand.length > 0 ? cand : "(no candidates — return catalogItemId null)",
    "",
    "Pick the best matching catalog id, or null if none fits. Provide confidence, a one-line rationale, and any ranked alternates.",
  ].join("\n");
}

/* --------------------------- Price tolerance ---------------------------- */

/**
 * True if the billed price is within tolerance of the catalog unit price.
 * Tolerance = the LARGER of ±pct and ±abs (prd.md §6). Compared on unit price;
 * falls back to amount/quantity if the line has no explicit unitPrice.
 */
function priceWithinTolerance(
  line: ExtractedLineItem,
  catalogUnitPrice: number | null | undefined,
  policy: PolicyConfig,
): { checked: boolean; withinTolerance: boolean; billedUnitPrice?: number; tolerance?: number } {
  if (catalogUnitPrice == null || !Number.isFinite(catalogUnitPrice)) {
    return { checked: false, withinTolerance: true };
  }

  let billedUnitPrice: number | undefined;
  if (line.unitPrice != null && Number.isFinite(line.unitPrice)) {
    billedUnitPrice = line.unitPrice;
  } else if (
    line.amount != null &&
    Number.isFinite(line.amount) &&
    line.quantity != null &&
    line.quantity > 0
  ) {
    billedUnitPrice = line.amount / line.quantity;
  }

  if (billedUnitPrice == null) {
    return { checked: false, withinTolerance: true };
  }

  const tolerance = Math.max(
    Math.abs(catalogUnitPrice) * policy.pricePctTolerance,
    policy.priceAbsTolerance,
  );
  const delta = Math.abs(billedUnitPrice - catalogUnitPrice);
  return {
    checked: true,
    withinTolerance: delta <= tolerance,
    billedUnitPrice,
    tolerance,
  };
}

/* --------------------------- Outcome classify --------------------------- */

/**
 * Classify the MatchOutcome from the LLM pick + policy thresholds + price check.
 * Order of precedence:
 *   - no pick / confidence < lowConfidence            -> unmatched
 *   - top-2 within AMBIGUITY_MARGIN of each other      -> ambiguous
 *   - matched but price out of tolerance               -> price_mismatch
 *   - confidence >= highConfidence                     -> matched_high
 *   - confidence in [lowConfidence, highConfidence)    -> matched_low
 */
function classifyOutcome(
  pick: PickResult,
  matchedItem: CatalogItem | undefined,
  line: ExtractedLineItem,
  policy: PolicyConfig,
): { outcome: MatchOutcome; priceEvidence?: Record<string, unknown> } {
  const conf = clamp01(pick.confidence);

  if (pick.catalogItemId == null || matchedItem == null || conf < policy.lowConfidence) {
    return { outcome: "unmatched" };
  }

  // Ambiguity: a strong alternate within the margin of the chosen one.
  const topAlt = (pick.alternates ?? [])
    .filter((a) => a.catalogItemId !== pick.catalogItemId)
    .map((a) => clamp01(a.confidence))
    .sort((a, b) => b - a)[0];
  if (
    topAlt != null &&
    topAlt >= policy.lowConfidence &&
    conf - topAlt < AMBIGUITY_MARGIN
  ) {
    return { outcome: "ambiguous" };
  }

  // Price reconciliation against the matched catalog item.
  const price = priceWithinTolerance(line, matchedItem.unitPrice, policy);
  if (price.checked && !price.withinTolerance) {
    return {
      outcome: "price_mismatch",
      priceEvidence: {
        billedUnitPrice: price.billedUnitPrice,
        catalogUnitPrice: matchedItem.unitPrice,
        tolerance: price.tolerance,
      },
    };
  }

  if (conf >= policy.highConfidence) return { outcome: "matched_high" };
  return { outcome: "matched_low" };
}

/* ------------------------------- Stage ---------------------------------- */

export const matchStage: MatchStage = async (input: MatchInput, deps): Promise<MatchOutput> => {
  const { mcp, llm, policy } = deps;
  const logger = deps.logger.child({ invoiceId: input.invoiceId, stage: "match" });

  // Without a resolved scope we cannot fetch the correct catalog. Carry every
  // line as unmatched so Decide can HOLD (NFR4 — never vanish), don't throw.
  if (input.sponsorId == null || input.studyId == null) {
    logger.warn(
      { sponsorId: input.sponsorId, studyId: input.studyId },
      "match: missing resolved scope; marking all lines unmatched",
    );
    const items: MatchedLineItem[] = input.lineItems.map((line, index) => ({
      ...line,
      index,
      matchedItemId: null,
      outcome: "unmatched",
      rationale: "No resolved sponsor/study scope; catalog could not be fetched.",
    }));
    return { items, catalogSize: 0 };
  }

  const catalog = await fetchScopedCatalog(mcp, input.sponsorId, input.studyId, logger);

  const byId = new Map<RefId, CatalogItem>();
  for (const c of catalog) byId.set(c.id, c);

  // Collect modelInfo from the first successful LLM call for the stage record.
  let stageModelInfo: MatchOutput["modelInfo"];

  const items: MatchedLineItem[] = [];
  for (let index = 0; index < input.lineItems.length; index += 1) {
    const line = input.lineItems[index];
    // Small catalog: send all of it (LLM handles acronyms/synonyms). Large
    // catalog: lexically shortlist to keep the prompt bounded (NFR2).
    const candidates =
      catalog.length <= SHORTLIST_FULL_THRESHOLD
        ? catalog
        : shortlist(line, catalog, SHORTLIST_SIZE);

    // No lexical candidates at all -> unmatched without spending an LLM call.
    if (candidates.length === 0) {
      items.push({
        ...line,
        index,
        matchedItemId: null,
        outcome: "unmatched",
        rationale: "No catalog candidate shared meaningful terms with this line.",
        candidates: [],
      });
      continue;
    }

    let pick: PickResult;
    try {
      const res = await llm.completeStructured<PickResult>({
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildLinePrompt(line, candidates) }],
        schema: PICK_SCHEMA as Record<string, unknown>,
        schemaName: "line_item_match",
        promptVersion: PROMPT_VERSION,
      });
      pick = res.value;
      stageModelInfo = stageModelInfo ?? res.modelInfo;
    } catch (err) {
      // LLM failure on this line: carry as unmatched so the invoice still
      // proceeds to Decide (it will HOLD). Other lines continue.
      logger.error({ index, err }, "match: LLM pick failed for line");
      items.push({
        ...line,
        index,
        matchedItemId: null,
        outcome: "unmatched",
        rationale: "Matching failed for this line (LLM error); held for QC.",
        candidates: toMatchCandidates(candidates),
      });
      continue;
    }

    const matchedItem =
      pick.catalogItemId != null ? byId.get(pick.catalogItemId) : undefined;
    const { outcome, priceEvidence } = classifyOutcome(pick, matchedItem, line, policy);

    // Build the ranked candidate list shown in the hub: the chosen item + the
    // shortlist, each carrying the LLM's confidence where it gave one.
    const altConf = new Map<number, number>();
    if (matchedItem) altConf.set(matchedItem.id, clamp01(pick.confidence));
    for (const a of pick.alternates ?? []) {
      if (!altConf.has(a.catalogItemId)) altConf.set(a.catalogItemId, clamp01(a.confidence));
    }
    const rankedCandidates = toMatchCandidates(candidates, altConf);

    const matched: MatchedLineItem = {
      ...line,
      index,
      matchedItemId: outcome === "unmatched" ? null : matchedItem?.id ?? null,
      outcome,
      matchConfidence: clamp01(pick.confidence),
      rationale: priceEvidence
        ? `${pick.rationale} (price out of tolerance: billed ${priceEvidence.billedUnitPrice} vs catalog ${priceEvidence.catalogUnitPrice})`
        : pick.rationale,
      candidates: rankedCandidates,
    };
    items.push(matched);
  }

  const summary = items.reduce<Record<MatchOutcome, number>>(
    (acc, it) => {
      acc[it.outcome] = (acc[it.outcome] ?? 0) + 1;
      return acc;
    },
    {
      matched_high: 0,
      matched_low: 0,
      ambiguous: 0,
      unmatched: 0,
      price_mismatch: 0,
    },
  );
  logger.info({ catalogSize: catalog.length, lineCount: items.length, summary }, "match: complete");

  return { items, catalogSize: catalog.length, modelInfo: stageModelInfo };
};

/** Map catalog items into the MatchCandidate shape, attaching LLM confidence where known. */
function toMatchCandidates(
  items: CatalogItem[],
  conf?: Map<number, number>,
): MatchCandidate[] {
  return items.map((c) => ({
    catalogItemId: c.id,
    itemCode: c.itemCode,
    description: c.description,
    catalogUnitPrice: c.unitPrice ?? null,
    confidence: conf?.get(c.id) ?? 0,
  }));
}

function clamp01(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export default matchStage;
