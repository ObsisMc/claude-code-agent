import type {
  AcpSender,
  AgentDiscovery,
  AgentDiscoveryContext,
  AgentModelApplied,
  AgentStartContext,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  AgentPlugin,
  type PluginContext,
  runAgentPlugin,
} from "./base/agent-plugin.ts";
import { forwardAcpFrame } from "./handlers/acp.ts";
import { startClaude, stopClaude } from "./handlers/lifecycle.ts";
import {
  discoverAgent,
  invalidateAllClaudeDiscovery,
  invalidateClaudeDiscovery,
} from "./handlers/discovery.ts";
import { ClaudeClient } from "./services/claude-client.ts";
import { logger } from "./services/log.ts";
import { PLUGIN_ID } from "./services/model-route.ts";

/**
 * Publishes Claude Code as an Ora agent.
 *
 * One plugin process is one agent, so this class owns exactly one adapter and needs no addressing
 * of its own. Every API is delegated to a handler module, which keeps the entrypoint to wiring: the
 * sender handed in by `agent/start`, the adapter bridge, and the route mounting below.
 */
class ClaudeAgentPlugin extends AgentPlugin {
  /** Valid only between `agent/start` and the end of the process; frames before that are lost. */
  #send: AcpSender | undefined;
  /** Set by `onActivate`, which the base class runs before the host can call anything. */
  #processes: HostProcesses | undefined;
  /**
   * Workspace of the live ACP process, used to invalidate its model catalog on lifecycle events.
   */
  #cwd: string | undefined;

  readonly #log = logger("plugin");

  readonly #client = new ClaudeClient({
    onAcpFrame: (frame) => {
      if (this.#send === undefined) {
        this.#log.warn(
          "dropping ACP frame from the adapter: no host sender yet",
          {
            context: acpFrameSummary(frame),
          },
        );
        return;
      }
      // A send failure means the host connection is already gone; there is nothing this plugin
      // can do with the frame, and throwing here would only kill the stdout pump.
      void this.#send(frame).catch((error) => {
        this.#log.warn("failed to forward ACP frame to the host", {
          context: acpFrameSummary(frame),
          error,
        });
      });
    },
    onExited: () => {
      if (this.#cwd !== undefined) {
        invalidateClaudeDiscovery(this.#cwd);
      }
      this.#log.warn(
        "the Claude ACP adapter exited on its own; Ora decides whether to reconnect",
        { context: { cwd: this.#cwd } },
      );
    },
  });

  override onActivate(context: PluginContext): void {
    this.#log.info(`${context.pluginId} activated`, {
      context: { pluginId: context.pluginId },
    });
    this.#processes = context.processes;
    this.#client.attachProcesses(context.processes);
  }

  override onStart = async (
    context: AgentStartContext,
    send: AcpSender,
  ): Promise<AgentModelApplied | void> => {
    this.#log.info("agent start requested", {
      context: { cwd: context.cwd, previousCwd: this.#cwd },
    });
    if (this.#cwd !== undefined) {
      invalidateClaudeDiscovery(this.#cwd);
    }
    this.#send = send;
    this.#cwd = context.cwd;
    invalidateClaudeDiscovery(context.cwd);
    return await startClaude(this.#client, context);
  };

  override onStop = async (): Promise<void> => {
    this.#log.info("agent stop requested", { context: { cwd: this.#cwd } });
    if (this.#cwd !== undefined) {
      invalidateClaudeDiscovery(this.#cwd);
    }
    await stopClaude(this.#client);
  };

  override onDiscover = (
    context: AgentDiscoveryContext,
  ): Promise<AgentDiscovery> =>
    discoverAgent(this.#client, this.#processes, context);

  override onAcp = (frame: JsonValue): Promise<void> | void =>
    forwardAcpFrame(this.#client, frame);

  override async onDeactivate(): Promise<void> {
    this.#log.info("plugin deactivating; stopping the adapter", {
      context: { cwd: this.#cwd, adapterRunning: this.#client.running },
    });
    invalidateAllClaudeDiscovery();
    await this.#client.stop();
  }
}

/** The envelope fields of one ACP frame that are safe to log: never its params or result. */
function acpFrameSummary(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return { shape: typeof frame };
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
    kind: "method" in frame
      ? ("id" in frame ? "request" : "notification")
      : ("error" in frame ? "error" : "response"),
  };
}

await runAgentPlugin(new ClaudeAgentPlugin(), { pluginId: PLUGIN_ID });
