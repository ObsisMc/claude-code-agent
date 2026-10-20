import {
  type AcpSender,
  AGENT_METHODS,
  type AgentEffectDefinition,
  type AgentModel,
  type AgentModelApplied,
  type AgentStartContext,
  createHostProcesses,
  defineAgent,
  type HostProcesses,
  type JsonValue,
  type PluginLogger,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import { installLogger, logger } from "../services/log.ts";

/**
 * Carries the process-level facts a plugin instance may need outside any agent session.
 *
 * The host hands session-scoped data (cwd, host version) to `onStart` instead, so this stays
 * limited to what is true for the whole plugin process. `processes` is how an agent plugin spawns
 * its CLI: the host owns that subprocess instead of this sandboxed runtime spawning it directly,
 * so it is torn down alongside this plugin generation no matter how that generation ends.
 */
export interface PluginContext {
  readonly pluginId: string;
  readonly processes: HostProcesses;
  /** The SDK-owned logger; the host persists its records into this plugin's own log file. */
  readonly logger: PluginLogger;
}

/** What the caller of {@link runAgentPlugin} supplies; `processes` is assembled internally. */
export interface RunAgentPluginOptions {
  readonly pluginId: string;
}

/**
 * Names the Workspace one model discovery call is answering for.
 *
 * Discovery happens outside any session, so this directory is the only thing telling a plugin
 * which project it is being asked about — a catalog that depends on the project's own
 * configuration cannot be resolved without it.
 */
export interface AgentListModelsContext {
  readonly cwd: string;
}

/**
 * Maps every class method onto the JSON-RPC method the Ora host invokes.
 *
 * The host contract fixes the wire names, so the mapping is explicit rather than derived from the
 * method name: a plugin that renamed `onListModels` would otherwise silently stop serving
 * `agent/list_models`.
 */
export const AGENT_METHOD_ROUTES = {
  onStart: AGENT_METHODS.start,
  onStop: AGENT_METHODS.stop,
  onListModels: AGENT_METHODS.listModels,
} as const;

/** Maps the class method that consumes host notifications onto its wire name. */
export const AGENT_NOTIFICATION_ROUTES = {
  onAcp: AGENT_METHODS.acp,
} as const;

/**
 * Base class for a `kind: "agent"` plugin, exposing agent contract version 1 as class methods.
 *
 * Required APIs are `abstract` so the compiler rejects an incomplete plugin, while optional APIs
 * ship a default implementation that can be overridden. Each method may also be mounted from a
 * separate module (`override onStart = handleStart`), which keeps a plugin with many APIs from
 * collapsing into one oversized entrypoint.
 */
export abstract class AgentPlugin {
  readonly type = "agent";

  // ------------------------- lifecycle hooks (optional) -------------------------

  /** Runs once before the plugin answers anything, for eager setup that must not race a call. */
  onActivate(_context: PluginContext): void | Promise<void> {}

  /** Runs once after the host closed the connection, for cleanup the host will not wait on. */
  onDeactivate(): void | Promise<void> {}

  // ------------------------- required agent contract ---------------------------

  /**
   * [agent/start] Brings the agent up so it can receive ACP frames.
   *
   * `send` stays valid for the rest of the process and is how every agent-originated ACP frame
   * reaches the host. Throw `PluginMethodError(AGENT_NOT_INSTALLED, ...)` when the underlying CLI
   * is missing, which the host treats as expected local configuration instead of a fault. A start
   * carrying `modelContext` must return the exact `AgentModelApplied` once that configuration is in
   * effect; the SDK fails the start otherwise, so ACP never begins on an unapplied route.
   */
  abstract onStart(
    context: AgentStartContext,
    send: AcpSender,
  ): void | AgentModelApplied | Promise<void | AgentModelApplied>;

  /** [agent/acp] Receives one ACP frame the host is forwarding to the agent. */
  abstract onAcp(frame: JsonValue): void | Promise<void>;

  /** [agent/list_models] Lists the models selectable in one Workspace before any session exists. */
  abstract onListModels(
    context: AgentListModelsContext,
  ): AgentModel[] | Promise<AgentModel[]>;

  // ------------------------- optional agent contract ---------------------------

  /** [agent/stop] Terminates the agent while leaving this plugin process alive. */
  onStop(): void | Promise<void> {}

  /**
   * Declares the Effect Resources this plugin consumes and coordinates their safe mutation.
   *
   * `undefined` opts the plugin out of the Effect contract entirely, which is the default for a
   * plugin with nothing Ora manages on disk. A plugin that owns one sets this to a value serving
   * `effect/coordinate`, `effect/reactivate`, and `effect/verify_ready`, typically by mounting a
   * handler module the same way `onStart` and friends are mounted above.
   */
  effects: AgentEffectDefinition | undefined = undefined;
}

/** One entry of the flattened dispatch table, already bound to its plugin instance. */
type BoundHandler = (...args: never[]) => unknown;

/**
 * Serves one agent plugin instance until the host shuts the process down.
 *
 * The instance is first flattened into a wire-name keyed table so dispatch never walks the
 * prototype chain, then adapted onto the SDK's agent definition, which owns the registration
 * handshake and the response shapes the host validates. `defineAgent` is called before
 * `onActivate` so `createHostProcesses` can be registered on the resulting `Plugin` while it is
 * still in its pre-run registering state — the same reason `onActivate` itself must run before
 * `definition.run()` starts serving host traffic.
 */
export async function runAgentPlugin(
  plugin: AgentPlugin,
  options: RunAgentPluginOptions,
): Promise<void> {
  const routes = flattenRoutes(plugin);

  const definition = defineAgent({
    start: (startContext, send) =>
      traced(
        AGENT_METHOD_ROUTES.onStart,
        () =>
          invoke(routes, AGENT_METHOD_ROUTES.onStart, startContext, send) as
            | void
            | AgentModelApplied
            | Promise<void | AgentModelApplied>,
      ),
    stop: () =>
      traced(
        AGENT_METHOD_ROUTES.onStop,
        () =>
          invoke(routes, AGENT_METHOD_ROUTES.onStop) as void | Promise<void>,
      ),
    listModels: (context) =>
      traced(
        AGENT_METHOD_ROUTES.onListModels,
        () =>
          invoke(routes, AGENT_METHOD_ROUTES.onListModels, context) as
            | AgentModel[]
            | Promise<AgentModel[]>,
      ),
    onAcp: (frame) =>
      invoke(routes, AGENT_NOTIFICATION_ROUTES.onAcp, frame) as
        | void
        | Promise<void>,
    effects: plugin.effects,
  });
  // The SDK logger exists from here on; adopt it before anything else can log, and route the
  // console through it now rather than at `run()`, because activation happens first and stdout
  // is the protocol channel.
  installLogger(definition.logger);
  protectProtocolStdout(definition.logger);
  const log = logger("plugin");
  log.info("plugin process starting", {
    context: {
      pluginId: options.pluginId,
      deno: Deno.version.deno,
      os: Deno.build.os,
      arch: Deno.build.arch,
      effects: plugin.effects?.resources.map((resource) =>
        resource.workspaceRelativePath
      ) ?? [],
    },
  });

  const processes = createHostProcesses(definition);
  await plugin.onActivate({
    pluginId: options.pluginId,
    processes,
    logger: definition.logger,
  });

  try {
    await definition.run();
    log.info("host connection closed; plugin process shutting down");
  } catch (error) {
    log.error("plugin run loop failed", { error });
    throw error;
  } finally {
    await plugin.onDeactivate();
  }
}

/**
 * Logs one host method call's start, duration, and outcome around the routed handler.
 *
 * Failures are logged at `warn` rather than `error`: an `AGENT_NOT_INSTALLED` answer is expected
 * local configuration from the host's point of view, and the host decides what to do with the
 * error code itself. The record carries the message and code, never the params, which for
 * `agent/start` include environment details the log has no business persisting.
 */
async function traced<T>(
  method: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const log = logger("host-call");
  const startedAt = performance.now();
  log.debug(`${method} received`, { method });
  try {
    const result = await run();
    log.info(`${method} completed`, {
      method,
      context: { durationMs: Math.round(performance.now() - startedAt) },
    });
    return result;
  } catch (error) {
    log.warn(`${method} failed`, {
      method,
      context: {
        durationMs: Math.round(performance.now() - startedAt),
        code: error instanceof PluginMethodError ? error.code : undefined,
      },
      error,
    });
    throw error;
  }
}

/**
 * Routes every console method through the plugin logger before any plugin code can run.
 *
 * The SDK does the same when `run()` starts, but activation happens before that, and stdout is
 * the binary protocol channel: a single `console.log` in `onActivate` would be read by the host
 * as a corrupt frame and take the whole plugin down. The mapping matches the SDK's own so the
 * persisted level of a `console.*` call does not depend on when it was made.
 */
function protectProtocolStdout(log: PluginLogger): void {
  const console_ = log.child({ target: "console" });
  const render = (values: unknown[]) =>
    values
      .map((value) => (typeof value === "string" ? value : Deno.inspect(value)))
      .join(" ");
  console.debug = (...values: unknown[]) => console_.debug(render(values));
  console.info = (...values: unknown[]) => console_.info(render(values));
  console.log = (...values: unknown[]) => console_.info(render(values));
  console.warn = (...values: unknown[]) => console_.warn(render(values));
  console.error = (...values: unknown[]) => console_.error(render(values));
}

/**
 * Collects every implemented API of one instance into a wire-name keyed dispatch table.
 *
 * Both class methods and instance fields are scanned, because mounting a handler module as a
 * field (`override onStart = handleStart`) is a supported way to organize a large plugin. Own
 * properties win over inherited ones, so an override always shadows the base implementation.
 */
function flattenRoutes(plugin: AgentPlugin): Map<string, BoundHandler> {
  const routes = new Map<string, BoundHandler>();
  const implemented = collectCallableNames(plugin);
  const source = plugin as unknown as Record<string, BoundHandler>;
  for (
    const [name, method] of Object.entries({
      ...AGENT_METHOD_ROUTES,
      ...AGENT_NOTIFICATION_ROUTES,
    })
  ) {
    if (!implemented.has(name)) {
      throw new Error(
        `Agent plugin does not implement ${name}, required for ${method}`,
      );
    }
    routes.set(method, source[name].bind(plugin));
  }
  return routes;
}

/** Walks the prototype chain once, returning the names that resolve to callable members. */
function collectCallableNames(instance: object): Set<string> {
  const names = new Set<string>();
  const source = instance as Record<string, unknown>;
  let current: object | null = instance;
  while (current !== null && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== "constructor" && typeof source[name] === "function") {
        names.add(name);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return names;
}

/** Dispatches one wire method through the flattened table. */
function invoke(
  routes: Map<string, BoundHandler>,
  method: string,
  ...args: unknown[]
): unknown {
  const handler = routes.get(method);
  if (handler === undefined) {
    throw new Error(`Method '${method}' is not implemented by this plugin.`);
  }
  return handler(...(args as never[]));
}
