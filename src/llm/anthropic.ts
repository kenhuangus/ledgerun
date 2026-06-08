/**
 * Anthropic LLM client (architecture.md §6). Owned by the LLM module.
 *
 * Implements the provider-agnostic LlmClient contract (src/contracts/llm.ts):
 *  - completeStructured<T>(): one-shot structured output for Extract + Match.
 *    Implemented via tool/JSON-schema forcing — we register a single tool whose
 *    input_schema is the caller's JsonSchema and force `tool_choice` to it, so
 *    the model is obliged to emit exactly that shape. This works across SDK
 *    versions and does not rely on the newer structured-outputs surface.
 *  - runToolLoop<T>(): the agentic tool-use loop the Resolve stage needs. Drives
 *    a manual loop over `onToolCall` until the model stops emitting tool calls,
 *    optionally coercing the terminal message into T via a forced final tool
 *    call when `finalSchema` is supplied.
 *
 * Model + key come from src/config (ANTHROPIC_API_KEY, ANTHROPIC_MODEL).
 * 429/5xx are retried with bounded exponential backoff (the SDK also retries,
 * but we add our own bounded layer for observability + jitter).
 *
 * NOTE on sampling params: Opus 4.7/4.8 reject `temperature`/`top_p`. The
 * contract exposes an optional `temperature`; we only forward it when the caller
 * explicitly sets it (callers targeting Opus 4.8 should leave it unset).
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  CompleteStructuredInput,
  CompleteStructuredResult,
  JsonSchema,
  LlmClient,
  LlmMessage,
  LlmToolCall,
  LlmToolSpec,
  ModelInfo,
  RunToolLoopInput,
  RunToolLoopResult,
} from "@/contracts";
import { config } from "@/config";
import { logger as rootLogger } from "@/lib/logger";

const log = rootLogger.child({ component: "AnthropicLlmClient" });

/** Default token ceilings — generous, non-streaming stays under SDK timeout. */
const DEFAULT_MAX_TOKENS = 8000;
/** Default safety bound on the resolve tool loop. */
const DEFAULT_MAX_ITERATIONS = 12;
/** Name used when the caller doesn't supply one. */
const DEFAULT_SCHEMA_NAME = "structured_output";

/** Bounded retry config for 429 / 5xx. */
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;

type AnthropicMessageParam = Anthropic.Messages.MessageParam;
type AnthropicTool = Anthropic.Messages.Tool;

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    const apiKey = opts?.apiKey ?? config.ANTHROPIC_API_KEY;
    this.model = opts?.model ?? config.ANTHROPIC_MODEL;
    // The SDK throws at call time if the key is empty; we let that surface so
    // tsc/unit contexts without a key don't fail at construction.
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
  }

  /* --------------------------- completeStructured -------------------------- */

  async completeStructured<T>(
    input: CompleteStructuredInput<T>,
  ): Promise<CompleteStructuredResult<T>> {
    const schemaName = sanitizeToolName(input.schemaName ?? DEFAULT_SCHEMA_NAME);
    const tool: AnthropicTool = {
      name: schemaName,
      description:
        "Return the structured result. You MUST call this tool exactly once " +
        "with the fully-populated arguments and nothing else.",
      input_schema: toToolInputSchema(input.schema),
    };

    const message = await this.withRetry(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools: [tool],
        tool_choice: { type: "tool", name: schemaName },
        ...samplingOverrides(input.temperature),
      }),
    );

    const toolUse = message.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error(
        `LLM_STRUCTURED_NO_TOOL_CALL: model returned stop_reason=${message.stop_reason} ` +
          `without invoking the forced tool "${schemaName}"`,
      );
    }

    return {
      value: toolUse.input as T,
      modelInfo: toModelInfo(message, input.promptVersion),
    };
  }

  /* ------------------------------ runToolLoop ----------------------------- */

  async runToolLoop<T>(input: RunToolLoopInput<T>): Promise<RunToolLoopResult<T>> {
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const tools: AnthropicTool[] = input.tools.map(toAnthropicTool);

    const messages: AnthropicMessageParam[] = toAnthropicMessages(input.messages);
    const transcript: LlmMessage[] = [...input.messages];
    const allToolCalls: LlmToolCall[] = [];

    let lastModelInfo: ModelInfo | undefined;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations += 1;

      const message = await this.withRetry(() =>
        this.client.messages.create({
          model: this.model,
          max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: input.system,
          messages,
          tools,
          ...samplingOverrides(input.temperature),
        }),
      );
      lastModelInfo = toModelInfo(message, input.promptVersion);

      // Record any assistant text into the transcript for observability.
      const assistantText = extractText(message);
      if (assistantText) {
        transcript.push({ role: "assistant", content: assistantText });
      }

      // Persist the assistant turn (must echo full content incl. tool_use).
      messages.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0) {
        // Model is done. Coerce into T if a final schema was requested.
        const value = input.finalSchema
          ? await this.coerceFinal<T>(input, messages)
          : (parseTerminalValue<T>(assistantText));
        return { value, transcript, toolCalls: allToolCalls, modelInfo: lastModelInfo };
      }

      // Execute each tool call via the caller's handler.
      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const call: LlmToolCall = {
          id: tu.id,
          name: tu.name,
          input: (tu.input ?? {}) as Record<string, unknown>,
        };
        allToolCalls.push(call);

        let result;
        try {
          result = await input.onToolCall(call);
        } catch (err) {
          log.warn({ tool: call.name, err: String(err) }, "tool handler threw");
          result = {
            toolCallId: tu.id,
            content: { error: String(err) },
            isError: true,
          };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: serializeToolResult(result.content),
          ...(result.isError ? { is_error: true } : {}),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Loop exhausted — try a final forced coercion if requested, else throw.
    if (input.finalSchema) {
      const value = await this.coerceFinal<T>(input, messages);
      return {
        value,
        transcript,
        toolCalls: allToolCalls,
        modelInfo: lastModelInfo ?? fallbackModelInfo(this.model, input.promptVersion),
      };
    }
    throw new Error(
      `LLM_TOOL_LOOP_EXHAUSTED: reached maxIterations=${maxIterations} without a terminal message`,
    );
  }

  /**
   * Force the model to emit the final structured value via a one-shot forced
   * tool call appended to the existing conversation.
   */
  private async coerceFinal<T>(
    input: RunToolLoopInput<T>,
    messages: AnthropicMessageParam[],
  ): Promise<T> {
    const finalName = sanitizeToolName(input.finalSchemaName ?? "final_answer");
    const finalTool: AnthropicTool = {
      name: finalName,
      description:
        "Emit the final structured answer now. Call this tool exactly once with " +
        "the complete result derived from the conversation so far.",
      input_schema: toToolInputSchema(input.finalSchema as JsonSchema),
    };

    // The forced-tool request must end with a user turn — some models (e.g.
    // Opus 4.8) reject assistant-message prefill. When the model has just
    // produced a terminal assistant turn, append a user nudge; when we arrive
    // here after a tool_result (loop exhausted), the conversation already ends
    // with a user turn, so leave it as-is (avoids two consecutive user turns).
    const last = messages[messages.length - 1];
    const coerceMessages: AnthropicMessageParam[] =
      last?.role === "assistant"
        ? [
            ...messages,
            {
              role: "user",
              content: `Call the tool "${finalName}" now, exactly once, with the complete final result derived from the conversation above.`,
            },
          ]
        : messages;

    const message = await this.withRetry(() =>
      this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: input.system,
        messages: coerceMessages,
        tools: [finalTool],
        tool_choice: { type: "tool", name: finalName },
        ...samplingOverrides(input.temperature),
      }),
    );

    const toolUse = message.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolUse) {
      throw new Error(
        `LLM_FINAL_COERCION_FAILED: model did not call "${finalName}" (stop_reason=${message.stop_reason})`,
      );
    }
    return toolUse.input as T;
  }

  /* ------------------------------- retry ---------------------------------- */

  private async withRetry<R>(fn: () => Promise<R>): Promise<R> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt += 1;
        if (!isRetryable(err) || attempt > MAX_RETRIES) {
          throw err;
        }
        const delay = retryDelayMs(err, attempt);
        log.warn(
          { attempt, delay, err: errSummary(err) },
          "retrying LLM call after retryable error",
        );
        await sleep(delay);
      }
    }
  }
}

export function createLlmClient(): LlmClient {
  return new AnthropicLlmClient();
}

export default createLlmClient;

/* ------------------------------- helpers -------------------------------- */

/** Map our message shape to the SDK's. Roles already match (user|assistant). */
function toAnthropicMessages(messages: LlmMessage[]): AnthropicMessageParam[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function toAnthropicTool(spec: LlmToolSpec): AnthropicTool {
  return {
    name: sanitizeToolName(spec.name),
    description: spec.description,
    input_schema: toToolInputSchema(spec.inputSchema),
  };
}

/**
 * The SDK's Tool.input_schema is typed as `{ type: "object"; ... }`. Our
 * JsonSchema is an opaque record; coerce while guaranteeing a top-level object
 * type (the API requires an object schema for tool inputs).
 */
function toToolInputSchema(schema: JsonSchema): AnthropicTool["input_schema"] {
  const base = (schema && typeof schema === "object" ? schema : {}) as Record<
    string,
    unknown
  >;
  if (base.type !== "object") {
    return { type: "object", ...base } as AnthropicTool["input_schema"];
  }
  return base as AnthropicTool["input_schema"];
}

/** Anthropic tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : DEFAULT_SCHEMA_NAME;
}

/**
 * Only forward `temperature` when explicitly set. Opus 4.7/4.8 reject sampling
 * params, so the safe default is to send nothing.
 */
function samplingOverrides(temperature?: number): { temperature?: number } {
  return temperature === undefined ? {} : { temperature };
}

function extractText(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Best-effort parse of a terminal assistant message when no finalSchema given. */
function parseTerminalValue<T>(text: string): T {
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

function serializeToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toModelInfo(
  message: Anthropic.Messages.Message,
  promptVersion?: string,
): ModelInfo {
  return {
    model: message.model,
    promptVersion: promptVersion ?? "v1",
    inputTokens: message.usage?.input_tokens,
    outputTokens: message.usage?.output_tokens,
  };
}

function fallbackModelInfo(model: string, promptVersion?: string): ModelInfo {
  return { model, promptVersion: promptVersion ?? "v1" };
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true; // 429
  if (err instanceof Anthropic.InternalServerError) return true; // 500
  if (err instanceof Anthropic.APIError) {
    const status = (err as { status?: number }).status;
    return status === 429 || (typeof status === "number" && status >= 500);
  }
  // Network-level errors (APIConnectionError) are retryable too.
  if (err instanceof Anthropic.APIConnectionError) return true;
  return false;
}

function retryDelayMs(err: unknown, attempt: number): number {
  // Honor Retry-After if present on a rate-limit error.
  if (err instanceof Anthropic.APIError) {
    const headers = (err as { headers?: Record<string, string> }).headers;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (!Number.isNaN(secs)) return secs * 1000;
    }
  }
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(exp + jitter, 15_000);
}

function errSummary(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    return `${err.name}(${(err as { status?: number }).status ?? "?"}): ${err.message}`;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
