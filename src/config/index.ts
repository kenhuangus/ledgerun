/**
 * Centralized config — env loading via zod + the default decision policy.
 * Import `config` for env, `getPolicy()` for the PolicyConfig (env-overridable).
 */

import { z } from "zod";
import { DEFAULT_POLICY, type PolicyConfig } from "@/contracts";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgresql://ledgerun:ledgerun@localhost:5432/ledgerun?schema=public"),
  REFERENCE_API_URL: z.string().url().default("http://localhost:8000"),
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-8"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_SERVER_URL: z.string().url().default("http://localhost:7000"),
  DROP_FOLDER: z.string().default("./.drop"),
  UPLOAD_DIR: z.string().default("./uploads"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // optional policy overrides
  POLICY_HIGH_CONFIDENCE: z.coerce.number().optional(),
  POLICY_LOW_CONFIDENCE: z.coerce.number().optional(),
  POLICY_PRICE_PCT_TOLERANCE: z.coerce.number().optional(),
  POLICY_PRICE_ABS_TOLERANCE: z.coerce.number().optional(),
  POLICY_MAX_LOW_CONFIDENCE_AUTO_SUBMIT: z.coerce.number().int().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/**
 * Parsed, validated env. Uses safeParse so a missing key in a non-runtime
 * context (e.g. tsc, unit tests) falls back to defaults rather than throwing at
 * import time. Call `assertRuntimeConfig()` where real credentials are required.
 */
export const config: AppConfig = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  // Fall back to schema defaults if validation fails (e.g. bad URL in tests).
  return EnvSchema.parse({});
})();

/** Throw if credentials needed at runtime are absent. Call from entrypoints. */
export function assertRuntimeConfig(): void {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required at runtime");
  }
}

/** The decision policy, applying any env overrides over DEFAULT_POLICY. */
export function getPolicy(): PolicyConfig {
  return {
    ...DEFAULT_POLICY,
    ...(config.POLICY_HIGH_CONFIDENCE !== undefined && {
      highConfidence: config.POLICY_HIGH_CONFIDENCE,
    }),
    ...(config.POLICY_LOW_CONFIDENCE !== undefined && {
      lowConfidence: config.POLICY_LOW_CONFIDENCE,
    }),
    ...(config.POLICY_PRICE_PCT_TOLERANCE !== undefined && {
      pricePctTolerance: config.POLICY_PRICE_PCT_TOLERANCE,
    }),
    ...(config.POLICY_PRICE_ABS_TOLERANCE !== undefined && {
      priceAbsTolerance: config.POLICY_PRICE_ABS_TOLERANCE,
    }),
    ...(config.POLICY_MAX_LOW_CONFIDENCE_AUTO_SUBMIT !== undefined && {
      maxLowConfidenceAutoSubmit: config.POLICY_MAX_LOW_CONFIDENCE_AUTO_SUBMIT,
    }),
  };
}
