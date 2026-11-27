import type { JsonValue } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";
import { logger } from "../services/log.ts";

const log = logger("acp");

/**
 * Serves the `agent/acp` notification by piping one host frame into the adapter verbatim.
 *
 * The frame is never parsed. ACP carries its own ids, ordering, cancellation, `additionalDirectories`,
 * and `_meta` extensions, so anything this plugin decided about a payload would only be a second,
 * weaker copy of what the two ACP peers already agreed on.
 *
 * A frame that arrives while the adapter is down is dropped with a warning rather than throwing:
 * notifications have no response channel, so the host would never see the error, and failing the
 * handler cannot recover the frame either.
 */
export function forwardAcpFrame(
  client: ClaudeClient,
  frame: JsonValue,
): Promise<void> | void {
  if (!client.running) {
    log.warn("dropping host ACP frame: the Claude agent is not running", {
      context: summarize(frame),
    });
    return;
  }
  log.debug("host ACP frame forwarded to the adapter", {
    context: summarize(frame),
  });
  return client.writeAcp(frame);
}

/** The envelope fields of one frame that are safe to log: never its params or result. */
function summarize(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { shape: typeof frame };
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
  };
}
