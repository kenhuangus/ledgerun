/**
 * Shared pino-backed logger that satisfies the `Logger` contract (stages.ts).
 * Use `logger.child({ invoiceId })` to bind structured context.
 */

import pino from "pino";
import type { Logger } from "@/contracts";
import { config } from "@/config";

const root = pino({ level: config.LOG_LEVEL });

function wrap(p: pino.Logger): Logger {
  return {
    debug: (obj, msg) => p.debug(obj as object, msg),
    info: (obj, msg) => p.info(obj as object, msg),
    warn: (obj, msg) => p.warn(obj as object, msg),
    error: (obj, msg) => p.error(obj as object, msg),
    child: (bindings) => wrap(p.child(bindings)),
  };
}

export const logger: Logger = wrap(root);
