import type {
  AgentModelApplied,
  AgentStartContext,
} from "@ora-space/plugin-sdk";
import { INVALID_PARAMS, PluginMethodError } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";
import { logger } from "../services/log.ts";
import { modelRoute } from "../services/model-route.ts";

const log = logger("lifecycle");

/**
 * Serves `agent/start` by bringing the Claude ACP adapter up in the host's working directory.
 *
 * Ora calls this once per connection, before any session exists, so the adapter is already
 * accepting ACP frames when the host runs its own `initialize` handshake. Per-session directories
 * travel later in ACP `session/new`, not here.
 *
 * A platform-model start carries a frozen model context. It is confirmed once the adapter is
 * spawned with the route built from it in its environment, which is what the host waits for before
 * it lets ACP begin; a start without one keeps the adapter's own routing, exactly as on a local
 * desktop.
 */
export async function startClaude(
  client: ClaudeClient,
  context: AgentStartContext,
): Promise<AgentModelApplied | void> {
  if (context.cwd.trim() === "") {
    log.warn("agent/start refused: empty cwd");
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/start requires a non-empty cwd",
    );
  }
  const route = context.modelContext === undefined
    ? undefined
    : modelRoute(context.modelContext);
  client.useRoute(route);
  await client.start(context.cwd);
  log.info("Claude ACP adapter started for agent/start", {
    context: { cwd: context.cwd, platformRoute: route !== undefined },
  });
  return route?.applied;
}

/**
 * Serves `agent/stop` by killing the adapter while keeping this plugin process alive.
 *
 * A later `agent/start` respawns it, which is what lets Ora restart a failed agent without paying
 * for a new plugin handshake.
 */
export async function stopClaude(client: ClaudeClient): Promise<void> {
  const wasRunning = client.running;
  await client.stop();
  log.info("Claude ACP adapter stopped for agent/stop", {
    context: { wasRunning },
  });
}
