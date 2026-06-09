/**
 * MCP client unit tests (architecture.md §5).
 *
 * Drives the REAL DirectMcpClient (which proxies the server tool functions) with
 * the global `fetch` stubbed. Asserts the reference-API boundary semantics:
 *   - snake_case reference rows -> camelCase domain types
 *     (sponsor_id->sponsorId, protocol_number->protocolNumber,
 *      item_code->itemCode, unit_price->unitPrice)
 *   - the {items,total,page,page_size,pages} envelope is unwrapped
 *   - searchCatalogItems forwards sponsor_id + study_id upstream
 *   - the client-side `query` filter narrows results
 *
 * NOTE: the server tool fns use module-level TTL caches keyed by entity scope.
 * Each test uses a DISTINCT sponsor/study scope so cached reads never collide.
 *
 * OFFLINE: no network (fetch is stubbed), no DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DirectMcpClient } from "@/mcp/client";

/** Build a Response-like object for the stubbed fetch. */
function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function envelope<T>(items: T[], pageSize = 100): {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
} {
  return { items, total: items.length, page: 1, page_size: pageSize, pages: 1 };
}

/** The fetch calls made, captured for assertions. */
let fetchCalls: string[] = [];

/** Route by path; returns the matching snake_case envelope. */
function routeFetch(url: string): Response {
  fetchCalls.push(url);
  const u = new URL(url);
  const path = u.pathname;

  if (path.endsWith("/api/v1/sponsors")) {
    return jsonResponse(
      envelope([
        { id: 7, name: "Northwind Pharma", code: "NW" },
        { id: 8, name: "Contoso Therapeutics", code: "CON" },
      ]),
    );
  }
  if (path.endsWith("/api/v1/studies")) {
    return jsonResponse(
      envelope([
        {
          id: 70,
          sponsor_id: 7,
          name: "LUMIN-2024",
          protocol_number: "NW-LUM-2024",
          phase: "II",
          therapeutic_area: "oncology",
        },
      ]),
    );
  }
  if (path.endsWith("/api/v1/study-sites")) {
    return jsonResponse(
      envelope([{ id: 700, study_id: 70, site_id: 90, status: "active" }]),
    );
  }
  if (path.endsWith("/api/v1/catalog-items")) {
    return jsonResponse(
      envelope(
        [
          { id: 1001, sponsor_id: 7, study_id: 70, item_code: "LAB-CBC", description: "Complete Blood Count", category: "lab_imaging", unit_price: "50.50" },
          { id: 1002, sponsor_id: 7, study_id: 70, item_code: "PV-001", description: "Screening visit", category: "patient_visits", unit_price: 500 },
        ],
        200,
      ),
    );
  }
  return jsonResponse(envelope([]));
}

describe("DirectMcpClient boundary mapping", () => {
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => routeFetch(String(url))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps snake_case sponsor rows -> camelCase and unwraps the envelope", async () => {
    const client = new DirectMcpClient();
    const sponsors = await client.listSponsors();
    // Envelope unwrapped to a plain array.
    expect(Array.isArray(sponsors)).toBe(true);
    expect(sponsors).toHaveLength(2);
    expect(sponsors[0]).toEqual({ id: 7, name: "Northwind Pharma", code: "NW" });
  });

  it("maps protocol_number -> protocolNumber and sponsor_id -> sponsorId on studies", async () => {
    const client = new DirectMcpClient();
    const studies = await client.listStudies({ sponsorId: 7 });
    expect(studies[0]).toMatchObject({
      id: 70,
      sponsorId: 7,
      name: "LUMIN-2024",
      protocolNumber: "NW-LUM-2024",
      phase: "II",
      therapeuticArea: "oncology",
    });
    // Upstream call carried the snake_case sponsor_id filter.
    const studiesCall = fetchCalls.find((c) => c.includes("/api/v1/studies"));
    expect(studiesCall).toBeDefined();
    expect(studiesCall).toContain("sponsor_id=7");
  });

  it("maps study_id/site_id -> studyId/siteId on study-sites", async () => {
    const client = new DirectMcpClient();
    const links = await client.listStudySites({ studyId: 70, siteId: 90 });
    expect(links[0]).toMatchObject({ id: 700, studyId: 70, siteId: 90, status: "active" });
  });

  it("maps item_code/unit_price -> itemCode/unitPrice and forwards sponsor_id+study_id", async () => {
    const client = new DirectMcpClient();
    const page = await client.searchCatalogItems({ sponsorId: 7, studyId: 70 });

    // Envelope kept (catalog tool returns Paginated) but fields camelCased.
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBeGreaterThan(0);
    expect(page.items[0]).toMatchObject({
      id: 1001,
      sponsorId: 7,
      studyId: 70,
      itemCode: "LAB-CBC",
      description: "Complete Blood Count",
      unitPrice: 50.5, // stringy "50.50" coerced to number
    });
    expect(page.items[1].itemCode).toBe("PV-001");
    expect(page.items[1].unitPrice).toBe(500);

    // The upstream catalog request carried sponsor_id + study_id.
    const catalogCall = fetchCalls.find((c) => c.includes("/api/v1/catalog-items"));
    expect(catalogCall).toBeDefined();
    expect(catalogCall).toContain("sponsor_id=7");
    expect(catalogCall).toContain("study_id=70");
  });

  it("applies the client-side `query` filter to narrow catalog results", async () => {
    const client = new DirectMcpClient();
    // Distinct scope (8:80) so we don't hit the cached 7:70 catalog above.
    const all = await client.searchCatalogItems({ sponsorId: 8, studyId: 80 });
    expect(all.items).toHaveLength(2);

    const filtered = await client.searchCatalogItems({
      sponsorId: 8,
      studyId: 80,
      query: "blood",
    });
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].itemCode).toBe("LAB-CBC");
    expect(filtered.total).toBe(1);
  });

  it("narrows sponsors via the client-side fuzzy query filter", async () => {
    const client = new DirectMcpClient();
    const filtered = await client.listSponsors("contoso");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].code).toBe("CON");
  });
});
