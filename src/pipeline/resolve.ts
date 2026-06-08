/**
 * Resolve stage (FR3). Owned by Stream C.
 *
 * Drives a Claude tool-use loop over the MCP tools to resolve
 * sponsor -> study -> site -> study-site. Reconciles conflicting invoice
 * metadata using the documented priority (protocol# > study name >
 * sponsor name > site name; prd.md §12) and produces a ResolveOutput with the
 * resolved reference ids, a ResolutionStatus, a confidence, and structured
 * evidence (candidates weighed, deciding signal, corrections applied, tool
 * calls). See architecture.md §4 and §6.
 *
 * The deterministic policy (Decide) owns the verdict; this stage never decides
 * SUBMIT/HOLD. An `ambiguous`/`unresolved` context is CARRIED, not blocked
 * (architecture.md §4): we still return a best-effort result so matching can run
 * and Decide can turn the status into a HOLD reason.
 */

import type {
  ResolveStage,
  ResolveOutput,
  ResolutionCandidate,
  ResolutionEvidence,
  LlmToolSpec,
  LlmToolCall,
  LlmToolResult,
  McpClient,
  RefId,
  ResolutionStatus,
  Logger,
} from "@/contracts";
import { MCP_TOOL_NAMES } from "@/contracts";

const PROMPT_VERSION = "resolve-v1";

/* --------------------------- LLM tool specs ----------------------------- */

/**
 * The MCP tools exposed to Claude during the resolve loop. These mirror the six
 * canonical tool names; the orchestrator-side handler (onToolCall) dispatches
 * each back to the McpClient.
 */
const RESOLVE_TOOLS: LlmToolSpec[] = [
  {
    name: MCP_TOOL_NAMES.listSponsors,
    description:
      "List/search sponsors by name. Pass a fuzzy `query` (e.g. a sponsor name read off the invoice) to filter; omit to list all. Returns sponsors with numeric id, name, code.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Fuzzy sponsor-name filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAMES.listStudies,
    description:
      "List/search studies (protocols). Filter by `sponsorId` and/or a fuzzy `query` matched against study name and protocol number. The protocol number is the HIGHEST-PRIORITY resolution signal — prefer matching it exactly when the invoice states one.",
    inputSchema: {
      type: "object",
      properties: {
        sponsorId: { type: "number", description: "Restrict to one sponsor." },
        query: {
          type: "string",
          description: "Fuzzy filter on study name OR protocol number.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAMES.listSites,
    description:
      "List/search clinical-trial sites by name, PI, or location. Pass a fuzzy `query`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Fuzzy site-name/PI/location filter." },
      },
      additionalProperties: false,
    },
  },
  {
    name: MCP_TOOL_NAMES.listStudySites,
    description:
      "Confirm a valid study<->site association. Filter by `studyId` and/or `siteId`. Use this to verify the resolved site actually belongs to the resolved study, and to obtain the studySiteId.",
    inputSchema: {
      type: "object",
      properties: {
        studyId: { type: "number" },
        siteId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
];

/* --------------------------- Final schema ------------------------------- */

/**
 * The structured object Claude must return at the end of the loop. We coerce the
 * terminal message into this via runToolLoop's finalSchema. ids are numeric (the
 * reference API uses integer ids); use null when a level could not be resolved.
 */
const FINAL_SCHEMA = {
  type: "object",
  properties: {
    sponsorId: { type: ["number", "null"] },
    studyId: { type: ["number", "null"] },
    siteId: { type: ["number", "null"] },
    studySiteId: { type: ["number", "null"] },
    status: {
      type: "string",
      enum: ["resolved_high", "resolved_corrected", "ambiguous", "unresolved"],
      description:
        "resolved_high = unique confident match with no metadata conflict. resolved_corrected = resolved after reconciling a conflict (e.g. protocol number overrode a wrong sponsor/study/site name). ambiguous = multiple plausible candidates remained. unresolved = no confident match.",
    },
    confidence: {
      type: "number",
      description: "0..1 overall confidence in the resolved context.",
    },
    candidates: {
      type: "array",
      description: "Every candidate weighed, for audit.",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["sponsor", "study", "site", "study_site"] },
          refId: { type: "number" },
          label: { type: "string" },
          matchedOn: {
            type: "string",
            enum: ["protocol_number", "study_name", "sponsor_name", "site_name", "other"],
          },
          score: { type: "number" },
        },
        required: ["kind", "refId", "label", "matchedOn", "score"],
        additionalProperties: false,
      },
    },
    decidingSignal: {
      type: ["string", "null"],
      enum: ["protocol_number", "study_name", "sponsor_name", "site_name", "other", null],
      description: "Which signal ultimately won the resolution.",
    },
    corrections: {
      type: "array",
      description:
        "One entry per invoice metadata field whose stated value conflicted with the canonical record and had to be reconciled.",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          statedValue: { type: ["string", "null"] },
          resolvedValue: { type: ["string", "null"] },
          note: { type: ["string", "null"] },
        },
        required: ["field"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "confidence"],
  additionalProperties: false,
} as const;

/** Shape Claude returns; mapped onto ResolveOutput + ResolutionEvidence. */
interface ResolveLlmResult {
  sponsorId?: number | null;
  studyId?: number | null;
  siteId?: number | null;
  studySiteId?: number | null;
  status: ResolutionStatus;
  confidence: number;
  candidates?: ResolutionCandidate[];
  decidingSignal?: ResolutionEvidence["decidingSignal"] | null;
  corrections?: ResolutionEvidence["corrections"];
}

/* ----------------------------- Tool dispatch ---------------------------- */

/**
 * Dispatch a Claude tool call to the McpClient. Records the call (for evidence)
 * and returns the tool result fed back into the loop. Errors are returned as
 * isError results so the model can recover rather than crashing the loop.
 */
function makeToolHandler(
  mcp: McpClient,
  recorded: Array<{ name: string; input: unknown }>,
  logger: Logger,
): (call: LlmToolCall) => Promise<LlmToolResult> {
  return async (call: LlmToolCall): Promise<LlmToolResult> => {
    recorded.push({ name: call.name, input: call.input });
    try {
      const input = call.input ?? {};
      let content: unknown;
      switch (call.name) {
        case MCP_TOOL_NAMES.listSponsors: {
          const query = typeof input.query === "string" ? input.query : undefined;
          content = await mcp.listSponsors(query);
          break;
        }
        case MCP_TOOL_NAMES.listStudies: {
          content = await mcp.listStudies({
            sponsorId: numOrUndef(input.sponsorId),
            query: typeof input.query === "string" ? input.query : undefined,
          });
          break;
        }
        case MCP_TOOL_NAMES.listSites: {
          const query = typeof input.query === "string" ? input.query : undefined;
          content = await mcp.listSites(query);
          break;
        }
        case MCP_TOOL_NAMES.listStudySites: {
          content = await mcp.listStudySites({
            studyId: numOrUndef(input.studyId),
            siteId: numOrUndef(input.siteId),
          });
          break;
        }
        default:
          logger.warn({ tool: call.name }, "resolve: unknown tool call");
          return {
            toolCallId: call.id,
            content: { error: `unknown tool: ${call.name}` },
            isError: true,
          };
      }
      return { toolCallId: call.id, content };
    } catch (err) {
      logger.error({ tool: call.name, err }, "resolve: MCP tool call failed");
      return {
        toolCallId: call.id,
        content: { error: err instanceof Error ? err.message : String(err) },
        isError: true,
      };
    }
  };
}

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function refIdOrUndef(v: unknown): RefId | undefined {
  return numOrUndef(v);
}

/* ------------------------------- Prompt --------------------------------- */

function buildUserPrompt(metadata: ResolveInputMetadata): string {
  const lines: string[] = [];
  const m = metadata;
  const push = (label: string, pv?: { value: unknown; confidence: number }) => {
    if (pv && pv.value != null && String(pv.value).trim() !== "") {
      lines.push(`- ${label}: "${String(pv.value)}" (extraction confidence ${pv.confidence.toFixed(2)})`);
    }
  };
  push("Sponsor name (as written)", m.sponsorName);
  push("Study name (as written)", m.studyName);
  push("Protocol / study number (as written)", m.protocolNumber);
  push("Site name (as written)", m.siteName);

  return [
    "Resolve the clinical-trial context for this invoice against the canonical reference data.",
    "",
    "Invoice metadata as extracted (values may be wrong, abbreviated, or conflicting):",
    lines.length > 0 ? lines.join("\n") : "- (no usable context metadata was extracted)",
    "",
    "Resolve in this order: sponsor -> study -> site -> study-site, using the tools.",
    "Use list_studies to verify the protocol number; use list_study_sites to confirm the site belongs to the study and to get the studySiteId.",
    "",
    "CONFLICT PRIORITY (highest first): protocol number > study name > sponsor name > site name.",
    "If the stated sponsor/site name contradicts what the protocol number resolves to, TRUST THE PROTOCOL NUMBER, set status to `resolved_corrected`, and record each contradicting field under `corrections`.",
    "If multiple candidates remain plausible, return status `ambiguous`. If nothing confidently matches, return `unresolved`.",
    "Record every candidate you weighed under `candidates`. Then return the final structured result.",
  ].join("\n");
}

/** Local structural view of the metadata fields we read (provenanced values). */
interface ResolveInputMetadata {
  sponsorName?: { value: string; confidence: number };
  studyName?: { value: string; confidence: number };
  protocolNumber?: { value: string; confidence: number };
  siteName?: { value: string; confidence: number };
}

/* --------------------------- Deterministic fallback --------------------- */

/**
 * If no context metadata was extracted at all, there is nothing for the LLM to
 * resolve against — return `unresolved` deterministically without spending a
 * tool loop. Carried forward as a HOLD reason by Decide.
 */
function hasAnyContextSignal(m: ResolveInputMetadata): boolean {
  return Boolean(m.sponsorName || m.studyName || m.protocolNumber || m.siteName);
}

const SYSTEM_PROMPT = [
  "You are the context-resolution stage of an autonomous clinical-trial invoice pipeline.",
  "Your job: map the invoice's stated sponsor/study/site onto canonical reference entities using ONLY the provided tools.",
  "You never make a submit/hold decision — a downstream deterministic policy does that. Your job is an accurate, well-evidenced resolution.",
  "Reference entity ids are integers. Always verify associations (study belongs to sponsor; site belongs to study) before concluding.",
  "Be conservative: prefer `ambiguous`/`unresolved` over a confident-but-wrong match. The protocol number is the most trustworthy signal when present.",
].join(" ");

/* ------------------------------- Stage ---------------------------------- */

export const resolveStage: ResolveStage = async (input, deps) => {
  const { mcp, llm } = deps;
  const logger = deps.logger.child({ invoiceId: input.invoiceId, stage: "resolve" });

  // Narrow the provenanced metadata into the plain view we prompt with.
  const md = input.metadata;
  const metaView: ResolveInputMetadata = {
    sponsorName: md.sponsorName && { value: md.sponsorName.value, confidence: md.sponsorName.confidence },
    studyName: md.studyName && { value: md.studyName.value, confidence: md.studyName.confidence },
    protocolNumber:
      md.protocolNumber && { value: md.protocolNumber.value, confidence: md.protocolNumber.confidence },
    siteName: md.siteName && { value: md.siteName.value, confidence: md.siteName.confidence },
  };

  if (!hasAnyContextSignal(metaView)) {
    logger.warn({}, "resolve: no context signal extracted; returning unresolved");
    const evidence: ResolutionEvidence = { candidates: [], toolCalls: [] };
    return {
      status: "unresolved",
      confidence: 0,
      evidence,
    };
  }

  const recordedToolCalls: Array<{ name: string; input: unknown }> = [];
  const onToolCall = makeToolHandler(mcp, recordedToolCalls, logger);

  let llmResult: ResolveLlmResult;
  let modelInfo: ResolveOutput["modelInfo"];
  try {
    const loop = await llm.runToolLoop<ResolveLlmResult>({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(metaView) }],
      tools: RESOLVE_TOOLS,
      onToolCall,
      finalSchema: FINAL_SCHEMA as Record<string, unknown>,
      finalSchemaName: "context_resolution",
      maxIterations: 12,
      promptVersion: PROMPT_VERSION,
    });
    llmResult = loop.value;
    modelInfo = loop.modelInfo;
  } catch (err) {
    // The loop itself failed (LLM/MCP hard failure). Carry as unresolved with
    // the evidence we managed to gather; the orchestrator's retry/recovery and
    // the Decide policy take it from here (NFR4 — never silently vanish).
    logger.error({ err }, "resolve: tool loop failed");
    const evidence: ResolutionEvidence = {
      candidates: [],
      toolCalls: recordedToolCalls,
    };
    return { status: "unresolved", confidence: 0, evidence };
  }

  const status = normalizeStatus(llmResult.status);
  const evidence: ResolutionEvidence = {
    candidates: Array.isArray(llmResult.candidates) ? llmResult.candidates : [],
    decidingSignal: llmResult.decidingSignal ?? undefined,
    corrections:
      Array.isArray(llmResult.corrections) && llmResult.corrections.length > 0
        ? llmResult.corrections
        : undefined,
    toolCalls: recordedToolCalls,
  };

  const out: ResolveOutput = {
    sponsorId: refIdOrUndef(llmResult.sponsorId),
    studyId: refIdOrUndef(llmResult.studyId),
    siteId: refIdOrUndef(llmResult.siteId),
    studySiteId: refIdOrUndef(llmResult.studySiteId),
    status,
    confidence: clamp01(llmResult.confidence),
    evidence,
    modelInfo,
  };

  logger.info(
    {
      status: out.status,
      confidence: out.confidence,
      sponsorId: out.sponsorId,
      studyId: out.studyId,
      siteId: out.siteId,
      toolCalls: recordedToolCalls.length,
      corrections: evidence.corrections?.length ?? 0,
    },
    "resolve: complete",
  );

  return out;
};

function normalizeStatus(s: unknown): ResolutionStatus {
  if (
    s === "resolved_high" ||
    s === "resolved_corrected" ||
    s === "ambiguous" ||
    s === "unresolved"
  ) {
    return s;
  }
  return "unresolved";
}

function clamp01(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export default resolveStage;
