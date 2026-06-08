/**
 * LLM contracts — a provider-agnostic interface for structured output and
 * tool-use loops. Mirrors architecture.md §6 (Extract = single structured call;
 * Resolve = tool-use loop over MCP tools; Match = structured call per shortlist).
 * The Anthropic impl lives in src/llm/anthropic.ts; the provider is swappable.
 *
 * LOCKED CONTRACT.
 */

import type { ModelInfo } from "./invoice";

/** Chat roles supported across providers. */
export type LlmRole = "user" | "assistant";

/** A single conversation message. Content is plain text at this seam. */
export interface LlmMessage {
  role: LlmRole;
  content: string;
}

/**
 * A JSON Schema object describing the expected structured output. Kept as an
 * opaque record so callers can pass a hand-written schema or one derived from a
 * zod schema (via zod-to-json-schema) without coupling this contract to a
 * specific validation lib.
 */
export type JsonSchema = Record<string, unknown>;

/** Input to a single structured-output call. */
export interface CompleteStructuredInput<T> {
  /** System prompt. */
  system: string;
  messages: LlmMessage[];
  /** JSON Schema the model output must conform to (enforced via tool/JSON mode). */
  schema: JsonSchema;
  /**
   * Optional name for the schema/tool (some providers require it). Defaults to a
   * generic name in the impl.
   */
  schemaName?: string;
  /** Optional sampling overrides. */
  maxTokens?: number;
  temperature?: number;
  /** Optional prompt-version tag recorded into the returned ModelInfo. */
  promptVersion?: string;
}

/** Result of a structured call: the parsed value plus model/usage metadata. */
export interface CompleteStructuredResult<T> {
  value: T;
  modelInfo: ModelInfo;
}

/** A tool the model may call during a tool-use loop (e.g. the MCP tools). */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: JsonSchema;
}

/** A tool call the model emitted. */
export interface LlmToolCall {
  /** Provider-assigned id, echoed back on the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The caller's response to a tool call, fed back into the loop. */
export interface LlmToolResult {
  /** Must match the originating LlmToolCall.id. */
  toolCallId: string;
  /** JSON-serializable result returned to the model. */
  content: unknown;
  isError?: boolean;
}

/** Input to a tool-use loop. */
export interface RunToolLoopInput<T> {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  /**
   * Invoked for every tool call the model makes; returns the result fed back
   * into the loop. The impl drives the loop until the model stops calling tools.
   */
  onToolCall: (call: LlmToolCall) => Promise<LlmToolResult>;
  /**
   * Optional final-output schema. When provided, the impl coerces the model's
   * terminal message into T (e.g. via a required final structured call).
   */
  finalSchema?: JsonSchema;
  finalSchemaName?: string;
  maxTokens?: number;
  temperature?: number;
  /** Safety bound on loop iterations to prevent runaway tool calling. */
  maxIterations?: number;
  promptVersion?: string;
}

/** Result of a tool-use loop. */
export interface RunToolLoopResult<T> {
  /** Final structured value (present when finalSchema was supplied). */
  value: T;
  /** The full assistant text trail, for debugging/observability. */
  transcript: LlmMessage[];
  /** Every tool call made during the loop (for evidence/audit). */
  toolCalls: LlmToolCall[];
  modelInfo: ModelInfo;
}

/**
 * Provider-agnostic LLM client. Two capabilities:
 *  - completeStructured: one-shot structured output (Extract, Match).
 *  - runToolLoop: agentic tool-use loop wired to MCP tools (Resolve).
 */
export interface LlmClient {
  completeStructured<T>(input: CompleteStructuredInput<T>): Promise<CompleteStructuredResult<T>>;
  runToolLoop<T>(input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>>;
}
