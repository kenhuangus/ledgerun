/**
 * MCP server (architecture.md §5) — Stream A.
 *
 * A real `@modelcontextprotocol/sdk` server that wraps the reference API
 * (process.env.REFERENCE_API_URL, default http://localhost:8000) as the six
 * typed tools:
 *   list_sponsors, list_studies, list_sites, list_study_sites,
 *   search_catalog_items, health
 *
 * Responsibilities:
 *  - Proxy each tool to the corresponding reference endpoint with `fetch`.
 *  - Unwrap the `{items,total,page,page_size,pages}` pagination envelope.
 *  - Map snake_case upstream fields -> camelCase contract shapes.
 *  - Implement the `query`/`category` fuzzy filters CLIENT-SIDE (the reference
 *    API has no server-side search; it only filters by id).
 *  - Clamp catalog pageSize to <= 200.
 *  - Light in-memory caching of sponsors/studies/sites and per-(sponsorId,
 *    studyId) catalog reads.
 *
 * The server holds the reference-API base URL — the one auditable reference
 * boundary. Run via `npm run mcp` (tsx src/mcp-server/index.ts) over stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  MCP_TOOL_NAMES,
  type Sponsor,
  type Study,
  type Site,
  type StudySite,
  type CatalogItem,
  type Paginated,
  type McpHealth,
  type CatalogCategory,
} from "@/contracts";

// ---------------------------------------------------------------------------
// Reference API client (the single HTTP boundary)
// ---------------------------------------------------------------------------

const REFERENCE_API_URL = (
  process.env.REFERENCE_API_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

/** Reference API max page sizes (verified against the router constants). */
const CATALOG_MAX_PAGE_SIZE = 200;
const ENTITY_MAX_PAGE_SIZE = 100; // sponsors/studies/sites/study-sites

/** Raw upstream pagination envelope (snake_case page_size). */
interface RawPaginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
}

async function refGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${REFERENCE_API_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Reference API ${path} -> ${res.status} ${res.statusText}${
        body ? `: ${body.slice(0, 300)}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Fetch every page of an entity list endpoint (sponsors/studies/sites/
 * study-sites) so client-side fuzzy filtering sees the whole set. These tables
 * are small and slow-changing.
 */
async function refGetAll<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  // Safety cap to avoid an unbounded loop if the API misbehaves.
  const MAX_PAGES = 1000;
  for (; page <= MAX_PAGES; page++) {
    const env = await refGet<RawPaginated<T>>(path, {
      ...params,
      page,
      page_size: ENTITY_MAX_PAGE_SIZE,
    });
    all.push(...env.items);
    if (page >= env.pages || env.items.length === 0) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// snake_case -> camelCase mappers
// ---------------------------------------------------------------------------

interface RawSponsor {
  id: number;
  name: string;
  code: string;
}
interface RawStudy {
  id: number;
  sponsor_id: number;
  name: string;
  protocol_number: string;
  phase?: string | null;
  therapeutic_area?: string | null;
}
interface RawSite {
  id: number;
  name: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  pi_name?: string | null;
}
interface RawStudySite {
  id: number;
  study_id: number;
  site_id: number;
  status?: string | null;
}
interface RawCatalogItem {
  id: number;
  sponsor_id: number;
  study_id: number;
  item_code: string;
  description: string;
  category?: string | null;
  unit_price?: number | string | null;
}

function mapSponsor(r: RawSponsor): Sponsor {
  return { id: r.id, name: r.name, code: r.code };
}
function mapStudy(r: RawStudy): Study {
  return {
    id: r.id,
    sponsorId: r.sponsor_id,
    name: r.name,
    protocolNumber: r.protocol_number,
    phase: r.phase ?? null,
    therapeuticArea: r.therapeutic_area ?? null,
  };
}
function mapSite(r: RawSite): Site {
  return {
    id: r.id,
    name: r.name,
    city: r.city ?? null,
    state: r.state ?? null,
    country: r.country ?? null,
    piName: r.pi_name ?? null,
  };
}
function mapStudySite(r: RawStudySite): StudySite {
  return {
    id: r.id,
    studyId: r.study_id,
    siteId: r.site_id,
    status: r.status ?? null,
  };
}
function mapCatalogItem(r: RawCatalogItem): CatalogItem {
  let unitPrice: number | null = null;
  if (r.unit_price !== undefined && r.unit_price !== null) {
    const n =
      typeof r.unit_price === "string" ? Number(r.unit_price) : r.unit_price;
    unitPrice = Number.isFinite(n) ? n : null;
  }
  return {
    id: r.id,
    sponsorId: r.sponsor_id,
    studyId: r.study_id,
    itemCode: r.item_code,
    description: r.description,
    category: (r.category ?? null) as CatalogCategory | string | null,
    unitPrice,
  };
}

// ---------------------------------------------------------------------------
// Client-side fuzzy filtering
// ---------------------------------------------------------------------------

/**
 * Lightweight case-insensitive substring/token match used everywhere the
 * contract advertises a `query` filter. Matches if every whitespace-delimited
 * token of the query appears somewhere in the concatenated haystack fields.
 */
export function fuzzyMatch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = fields
    .filter((f): f is string => typeof f === "string" && f.length > 0)
    .join("  ")
    .toLowerCase();
  if (hay.length === 0) return false;
  const tokens = q.split(/\s+/);
  return tokens.every((t) => hay.includes(t));
}

// ---------------------------------------------------------------------------
// Light in-memory caches (small, slow-changing reference tables)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: T): void {
    this.store.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  }
}

const sponsorsCache = new TtlCache<Sponsor[]>();
const studiesCache = new TtlCache<Study[]>(); // keyed by sponsorId ("all" when none)
const sitesCache = new TtlCache<Site[]>();
const studySitesCache = new TtlCache<StudySite[]>(); // keyed by `${studyId}:${siteId}`
const catalogCache = new TtlCache<CatalogItem[]>(); // keyed by `${sponsorId}:${studyId}`

// ---------------------------------------------------------------------------
// Tool implementations (also exported so an in-process client can reuse them)
// ---------------------------------------------------------------------------

export async function toolListSponsors(query?: string): Promise<Sponsor[]> {
  let all = sponsorsCache.get("all");
  if (!all) {
    all = (await refGetAll<RawSponsor>("/api/v1/sponsors")).map(mapSponsor);
    sponsorsCache.set("all", all);
  }
  if (!query) return all;
  return all.filter((s) => fuzzyMatch(query, s.name, s.code));
}

export async function toolListStudies(input?: {
  sponsorId?: number;
  query?: string;
}): Promise<Study[]> {
  const sponsorId = input?.sponsorId;
  const key = sponsorId === undefined ? "all" : String(sponsorId);
  let scoped = studiesCache.get(key);
  if (!scoped) {
    scoped = (
      await refGetAll<RawStudy>("/api/v1/studies", { sponsor_id: sponsorId })
    ).map(mapStudy);
    studiesCache.set(key, scoped);
  }
  if (!input?.query) return scoped;
  return scoped.filter((s) =>
    fuzzyMatch(input.query!, s.name, s.protocolNumber, s.therapeuticArea, s.phase),
  );
}

export async function toolListSites(query?: string): Promise<Site[]> {
  let all = sitesCache.get("all");
  if (!all) {
    all = (await refGetAll<RawSite>("/api/v1/sites")).map(mapSite);
    sitesCache.set("all", all);
  }
  if (!query) return all;
  return all.filter((s) =>
    fuzzyMatch(query, s.name, s.piName, s.city, s.state, s.country),
  );
}

export async function toolListStudySites(input?: {
  studyId?: number;
  siteId?: number;
}): Promise<StudySite[]> {
  const key = `${input?.studyId ?? ""}:${input?.siteId ?? ""}`;
  let scoped = studySitesCache.get(key);
  if (!scoped) {
    scoped = (
      await refGetAll<RawStudySite>("/api/v1/study-sites", {
        study_id: input?.studyId,
        site_id: input?.siteId,
      })
    ).map(mapStudySite);
    studySitesCache.set(key, scoped);
  }
  return scoped;
}

export async function toolSearchCatalogItems(input: {
  sponsorId: number;
  studyId: number;
  query?: string;
  category?: CatalogCategory;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<CatalogItem>> {
  const key = `${input.sponsorId}:${input.studyId}`;
  let full = catalogCache.get(key);
  if (!full) {
    // Fetch the entire scoped catalog (paged at the API max) so client-side
    // query/category filtering + our own pagination operate on the full set.
    full = [];
    let apiPage = 1;
    const MAX_PAGES = 1000;
    for (; apiPage <= MAX_PAGES; apiPage++) {
      const env = await refGet<RawPaginated<RawCatalogItem>>(
        "/api/v1/catalog-items",
        {
          sponsor_id: input.sponsorId,
          study_id: input.studyId,
          page: apiPage,
          page_size: CATALOG_MAX_PAGE_SIZE,
        },
      );
      full.push(...env.items.map(mapCatalogItem));
      if (apiPage >= env.pages || env.items.length === 0) break;
    }
    catalogCache.set(key, full);
  }

  // Apply client-side category + fuzzy query filters.
  let filtered = full;
  if (input.category) {
    filtered = filtered.filter((c) => c.category === input.category);
  }
  if (input.query) {
    filtered = filtered.filter((c) =>
      fuzzyMatch(input.query!, c.description, c.itemCode, c.category ?? undefined),
    );
  }

  // Re-paginate the filtered set. pageSize clamped to [1, 200].
  const pageSize = Math.min(
    Math.max(1, Math.floor(input.pageSize ?? CATALOG_MAX_PAGE_SIZE)),
    CATALOG_MAX_PAGE_SIZE,
  );
  const total = filtered.length;
  const pages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pages);
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return { items, total, page, pageSize, pages };
}

export async function toolHealth(): Promise<McpHealth> {
  try {
    const raw = await refGet<{ status?: string }>("/health");
    const status = raw?.status;
    return { ok: status === "ok" || status === undefined, status };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// MCP server wiring
// ---------------------------------------------------------------------------

/** Wrap a structured payload into the MCP `content` text shape callers parse. */
function jsonContent(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "ledgerun-reference-mcp",
    version: "1.0.0",
  });

  const categoryEnum = z.enum([
    "patient_visits",
    "procedures",
    "lab_imaging",
    "administrative",
    "pass_through",
  ]);

  server.registerTool(
    MCP_TOOL_NAMES.listSponsors,
    {
      description:
        "Resolve clinical-trial sponsors by name/code. `query` is a client-side fuzzy filter.",
      inputSchema: {
        query: z.string().optional().describe("Fuzzy name/code filter."),
      },
    },
    async ({ query }) => jsonContent(await toolListSponsors(query)),
  );

  server.registerTool(
    MCP_TOOL_NAMES.listStudies,
    {
      description:
        "Resolve studies/protocols, optionally scoped to a sponsor. `query` fuzzy-matches name/protocol/therapeutic area.",
      inputSchema: {
        sponsorId: z.number().int().optional(),
        query: z.string().optional(),
      },
    },
    async ({ sponsorId, query }) =>
      jsonContent(await toolListStudies({ sponsorId, query })),
  );

  server.registerTool(
    MCP_TOOL_NAMES.listSites,
    {
      description:
        "Resolve trial sites by name/PI/location. `query` is a client-side fuzzy filter.",
      inputSchema: {
        query: z.string().optional(),
      },
    },
    async ({ query }) => jsonContent(await toolListSites(query)),
  );

  server.registerTool(
    MCP_TOOL_NAMES.listStudySites,
    {
      description:
        "Confirm valid study↔site associations. Provide studyId and/or siteId.",
      inputSchema: {
        studyId: z.number().int().optional(),
        siteId: z.number().int().optional(),
      },
    },
    async ({ studyId, siteId }) =>
      jsonContent(await toolListStudySites({ studyId, siteId })),
  );

  server.registerTool(
    MCP_TOOL_NAMES.searchCatalogItems,
    {
      description:
        "Fetch the scoped (sponsor+study) billable catalog, paged. `query` fuzzy-matches description/item code; `category` filters exactly. pageSize <= 200.",
      inputSchema: {
        sponsorId: z.number().int(),
        studyId: z.number().int(),
        query: z.string().optional(),
        category: categoryEnum.optional(),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ sponsorId, studyId, query, category, page, pageSize }) =>
      jsonContent(
        await toolSearchCatalogItems({
          sponsorId,
          studyId,
          query,
          category,
          page,
          pageSize,
        }),
      ),
  );

  server.registerTool(
    MCP_TOOL_NAMES.health,
    {
      description: "Reference-API readiness check used at orchestrator startup.",
      inputSchema: {},
    },
    async () => jsonContent(await toolHealth()),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `[ledgerun-mcp] connected over stdio; reference API = ${REFERENCE_API_URL}`,
  );
}

// Entrypoint: only start when invoked directly (tsx src/mcp-server/index.ts).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /mcp-server[\\/](index)\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  startMcpServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

export default startMcpServer;
