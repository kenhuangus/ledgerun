/**
 * MCP contracts — the domain types of the reference API and the McpClient
 * interface the orchestrator/LLM use to read canonical data. Mirrors
 * architecture.md §5 and the reference API schemas (services/api/app/schemas.py).
 *
 * IMPORTANT: the reference API uses INTEGER ids. We carry them as `number` here
 * to match the API verbatim. The Prisma layer stringifies them when persisting
 * (ContextResolution.sponsorId etc. are String? in schema.prisma).
 *
 * LOCKED CONTRACT.
 */

/** Reference-API entity id (integer in the upstream API). */
export type RefId = number;

/** Catalog item categories (reference README + architecture.md §5). */
export type CatalogCategory =
  | "patient_visits"
  | "procedures"
  | "lab_imaging"
  | "administrative"
  | "pass_through";

/** Sponsor. GET /api/v1/sponsors. */
export interface Sponsor {
  id: RefId;
  name: string;
  code: string;
}

/** Study/protocol. GET /api/v1/studies. */
export interface Study {
  id: RefId;
  sponsorId: RefId;
  name: string;
  protocolNumber: string;
  phase?: string | null;
  therapeuticArea?: string | null;
}

/** Clinical-trial site. GET /api/v1/sites. */
export interface Site {
  id: RefId;
  name: string;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  piName?: string | null;
}

/** Study↔site association. GET /api/v1/study-sites. */
export interface StudySite {
  id: RefId;
  studyId: RefId;
  siteId: RefId;
  status?: string | null;
}

/** Billable catalog item, scoped to a sponsor+study. GET /api/v1/catalog-items. */
export interface CatalogItem {
  id: RefId;
  sponsorId: RefId;
  studyId: RefId;
  itemCode: string;
  description: string;
  category?: CatalogCategory | string | null;
  /** Catalog unit price in major units; null if the API did not provide one. */
  unitPrice?: number | null;
}

/**
 * The reference API's pagination envelope. The MCP server unwraps this for most
 * tools, but the catalog search tool returns it so callers can page large
 * catalogs (NFR2).
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** Result of the MCP `health` tool. */
export interface McpHealth {
  ok: boolean;
  /** Raw upstream status string, e.g. "ok". */
  status?: string;
}

/** Input to listStudies. */
export interface ListStudiesInput {
  sponsorId?: RefId;
  /** Client-side fuzzy filter applied by the MCP server (name/protocol). */
  query?: string;
}

/** Input to listStudySites. At least one of studyId/siteId is normally given. */
export interface ListStudySitesInput {
  studyId?: RefId;
  siteId?: RefId;
}

/** Input to searchCatalogItems. sponsorId+studyId are required (scoped catalog). */
export interface SearchCatalogItemsInput {
  sponsorId: RefId;
  studyId: RefId;
  /** Client-side fuzzy filter on description/item_code applied by the MCP server. */
  query?: string;
  category?: CatalogCategory;
  page?: number;
  /** ≤ 200 (reference API max for catalog items). */
  pageSize?: number;
}

/**
 * The client every consumer (orchestrator deterministic lookups + the Claude
 * tool-use loop in Resolve) uses to reach reference data. The concrete impl
 * (src/mcp/client.ts) speaks to the MCP server; no caller touches the reference
 * HTTP API directly. Mirrors the six tools in architecture.md §5.
 */
export interface McpClient {
  /** list_sponsors — resolve sponsor by name (query is a client-side fuzzy filter). */
  listSponsors(query?: string): Promise<Sponsor[]>;
  /** list_studies — resolve study/protocol, optionally within a sponsor. */
  listStudies(input?: ListStudiesInput): Promise<Study[]>;
  /** list_sites — resolve site by name/PI/location. */
  listSites(query?: string): Promise<Site[]>;
  /** list_study_sites — confirm a valid study↔site association. */
  listStudySites(input?: ListStudySitesInput): Promise<StudySite[]>;
  /** search_catalog_items — fetch the scoped catalog, paged, for matching. */
  searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>>;
  /** health — readiness check used at orchestrator startup. */
  health(): Promise<McpHealth>;
}

/**
 * Canonical MCP tool names exposed by the server (architecture.md §5). Re-used by
 * both the server (registration) and the client (tool-use loop wiring) so the
 * names cannot drift between the two.
 */
export const MCP_TOOL_NAMES = {
  listSponsors: "list_sponsors",
  listStudies: "list_studies",
  listSites: "list_sites",
  listStudySites: "list_study_sites",
  searchCatalogItems: "search_catalog_items",
  health: "health",
} as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];
