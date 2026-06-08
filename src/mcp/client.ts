/**
 * MCP client (architecture.md §5, §2) — Stream A.
 *
 * The typed `McpClient` every consumer uses to reach reference data — the
 * orchestrator's deterministic lookups (Match) and the Claude tool-use loop
 * (Resolve). No caller touches the reference HTTP API directly.
 *
 * Two concrete implementations, both honoring the same contract:
 *
 *  1. `StdioMcpClient` — spawns the real MCP server (`tsx src/mcp-server/
 *     index.ts`) and talks to it over the official SDK stdio transport, calling
 *     the six locked tools by name and parsing the JSON text content back into
 *     typed shapes. This is the true MCP path.
 *
 *  2. `DirectMcpClient` — an in-process thin proxy that calls the exact same
 *     tool functions the server exposes (re-exported from the server module).
 *     Same boundary semantics (snake->camel mapping, fuzzy filtering, caching,
 *     pagination), no child process. Used as a robust default (and for tests /
 *     environments where spawning a child is impractical).
 *
 * `createMcpClient()` picks based on MCP_TRANSPORT: `stdio` -> StdioMcpClient,
 * anything else (default) -> DirectMcpClient.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  MCP_TOOL_NAMES,
  type McpClient,
  type Sponsor,
  type Study,
  type Site,
  type StudySite,
  type CatalogItem,
  type Paginated,
  type McpHealth,
  type ListStudiesInput,
  type ListStudySitesInput,
  type SearchCatalogItemsInput,
} from "@/contracts";

import {
  toolListSponsors,
  toolListStudies,
  toolListSites,
  toolListStudySites,
  toolSearchCatalogItems,
  toolHealth,
} from "@/mcp-server/index";

// ---------------------------------------------------------------------------
// Direct (in-process) client — thin typed proxy over the server tool fns.
// ---------------------------------------------------------------------------

export class DirectMcpClient implements McpClient {
  listSponsors(query?: string): Promise<Sponsor[]> {
    return toolListSponsors(query);
  }
  listStudies(input?: ListStudiesInput): Promise<Study[]> {
    return toolListStudies({ sponsorId: input?.sponsorId, query: input?.query });
  }
  listSites(query?: string): Promise<Site[]> {
    return toolListSites(query);
  }
  listStudySites(input?: ListStudySitesInput): Promise<StudySite[]> {
    return toolListStudySites({ studyId: input?.studyId, siteId: input?.siteId });
  }
  searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>> {
    return toolSearchCatalogItems(input);
  }
  health(): Promise<McpHealth> {
    return toolHealth();
  }
}

// ---------------------------------------------------------------------------
// Stdio client — real MCP transport against the spawned server process.
// ---------------------------------------------------------------------------

interface McpTextContent {
  type: string;
  text?: string;
}
interface McpToolResult {
  content?: McpTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Pull the first text block out of a CallTool result and JSON.parse it. */
function parseToolResult<T>(result: McpToolResult): T {
  if (result.isError) {
    const msg =
      result.content?.find((c) => c.type === "text")?.text ?? "unknown MCP tool error";
    throw new Error(`MCP tool error: ${msg}`);
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) {
    throw new Error("MCP tool returned no text content");
  }
  return JSON.parse(text) as T;
}

export class StdioMcpClient implements McpClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly opts: {
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    } = {},
  ) {}

  /** Lazily connect on first use; reuse the connection thereafter. */
  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const command = this.opts.command ?? "npx";
      const args = this.opts.args ?? ["tsx", "src/mcp-server/index.ts"];
      // Forward REFERENCE_API_URL (and the rest of the env) to the child so it
      // hits the same reference API.
      const env: Record<string, string> = {
        ...(this.opts.env ?? filterEnv(process.env)),
      };
      const transport = new StdioClientTransport({ command, args, env });
      const client = new Client({
        name: "ledgerun-app",
        version: "1.0.0",
      });
      await client.connect(transport);
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.ensureConnected();
    const result = (await client.callTool({
      name,
      arguments: args,
    })) as McpToolResult;
    return parseToolResult<T>(result);
  }

  listSponsors(query?: string): Promise<Sponsor[]> {
    return this.call<Sponsor[]>(MCP_TOOL_NAMES.listSponsors, { query });
  }
  listStudies(input?: ListStudiesInput): Promise<Study[]> {
    return this.call<Study[]>(MCP_TOOL_NAMES.listStudies, {
      sponsorId: input?.sponsorId,
      query: input?.query,
    });
  }
  listSites(query?: string): Promise<Site[]> {
    return this.call<Site[]>(MCP_TOOL_NAMES.listSites, { query });
  }
  listStudySites(input?: ListStudySitesInput): Promise<StudySite[]> {
    return this.call<StudySite[]>(MCP_TOOL_NAMES.listStudySites, {
      studyId: input?.studyId,
      siteId: input?.siteId,
    });
  }
  searchCatalogItems(input: SearchCatalogItemsInput): Promise<Paginated<CatalogItem>> {
    return this.call<Paginated<CatalogItem>>(MCP_TOOL_NAMES.searchCatalogItems, {
      sponsorId: input.sponsorId,
      studyId: input.studyId,
      query: input.query,
      category: input.category,
      page: input.page,
      pageSize: input.pageSize,
    });
  }
  health(): Promise<McpHealth> {
    return this.call<McpHealth>(MCP_TOOL_NAMES.health, {});
  }

  /** Close the underlying transport/child process. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

/** Drop undefined values so they satisfy Record<string,string>. */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Factory the app uses to obtain a connected client. Honors MCP_TRANSPORT:
 *  - "stdio": spawn + speak the real MCP protocol to the server process.
 *  - otherwise (default "direct"/"http"): in-process thin proxy.
 */
export function createMcpClient(): McpClient {
  const transport = process.env.MCP_TRANSPORT;
  if (transport === "stdio") {
    return new StdioMcpClient();
  }
  return new DirectMcpClient();
}

export default createMcpClient;
