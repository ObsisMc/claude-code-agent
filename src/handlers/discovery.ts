import type {
  AgentCommand,
  AgentDiscovery,
  AgentDiscoveryContext,
  AgentModel,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  AGENT_DISCOVERY_CLEANUP_RESERVE_MS,
  AGENT_METHODS,
  INVALID_PARAMS,
  PluginMethodError,
  skillSessionSetup,
  waitForAgentCommands,
} from "@ora-space/plugin-sdk";
import { AcpProbe, PROBE_BUDGET_MS } from "../services/acp-probe.ts";
import type { ClaudeClient } from "../services/claude-client.ts";
import { spawnClaude } from "../services/command.ts";
import { logger } from "../services/log.ts";

const log = logger("discovery");

/** The ACP revision this plugin speaks; the same one Ora declares on its own connection. */
const ACP_PROTOCOL_VERSION = 1;

/**
 * How long one discovery's answer is reused before Claude Code is asked again.
 *
 * Ora deliberately keeps no copy: discovery is on demand, so a picker that re-renders asks again,
 * and every ask costs an adapter start plus an ACP handshake. A short window collapses that burst
 * without outliving the reason a catalog changes — logging into a provider, or editing Claude
 * Code's config — which stays visible the next time the picker is opened.
 */
const CATALOG_TTL_MS = 5 * 60_000;

/** One discovery's in-flight or recent answer. */
interface CachedDiscovery {
  discovery: Promise<AgentDiscovery>;
  cwd: string;
  expiresAt: number;
}

/**
 * Answers by the whole discovery input except its deadline, in this process's memory only.
 *
 * Commands depend on the Skills a session would be given, and Ora says when those change through
 * `skills.revision`, so a cached answer is only reused for the very same input; a models-only
 * question and a question for commands are different inputs.
 */
const discoveries = new Map<string, CachedDiscovery>();

/** Drops the answers for one workspace so the next request probes the current adapter state. */
export function invalidateClaudeDiscovery(cwd: string): void {
  for (const [key, cached] of discoveries) {
    if (cached.cwd === cwd) {
      discoveries.delete(key);
    }
  }
}

/** Drops every answer when this plugin generation is going away. */
export function invalidateAllClaudeDiscovery(): void {
  discoveries.clear();
}

/**
 * Serves `agent/discover`: the frozen model on a platform route, discovery everywhere else.
 *
 * A platform route offers exactly its frozen model, and no commands. Probing would start an
 * adapter on the host's own credentials and routing — a run nobody admitted — and list what that
 * finds (discovery ADR D3 point 7). Discovery is answered for the Workspace the host named, not
 * for the directory `agent/start` was given: that one is neutral, and a user can open pickers for
 * a project this connection never ran in.
 */
export function discoverAgent(
  client: Pick<ClaudeClient, "frozenModel">,
  processes: HostProcesses | undefined,
  context: AgentDiscoveryContext,
): Promise<AgentDiscovery> {
  const frozen = client.frozenModel;
  if (frozen !== undefined) {
    return Promise.resolve({
      models: [{ id: frozen.id, displayName: frozen.name, default: true }],
    });
  }
  if (processes === undefined) {
    throw new Error(`${AGENT_METHODS.discover} was called before activation`);
  }
  return discoverClaude(processes, context);
}

/**
 * Serves `agent/discover` (and, through the SDK, `agent/list_models`) by asking Claude Code's
 * adapter itself.
 *
 * `claude-agent-acp` publishes its model choices in one place only: the `configOptions` an ACP
 * session carries, and its commands only in an `available_commands_update` after that session
 * exists. There is no pre-session listing to read, so discovery has to hold a whole ACP
 * conversation, which is why it needs its own process rather than the connection Ora is reading;
 * see {@link AcpProbe}.
 *
 * A concurrent second call with the same input joins the promise already in flight rather than
 * starting a second adapter: Ora renders the agent picker and the workflow inspector
 * independently, and both ask on open.
 *
 * The directory is checked rather than assumed: this plugin cannot invent a workspace to answer
 * for, and saying so beats a probe spawned against nothing failing seconds later about an adapter.
 */
export function discoverClaude(
  processes: HostProcesses,
  context: AgentDiscoveryContext,
): Promise<AgentDiscovery> {
  const { cwd, includeCommands } = context;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    log.warn("agent/discover refused: no workspace cwd");
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/discover requires the cwd of the workspace to discover for",
    );
  }
  const key = discoveryKey(context);
  const cached = discoveries.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    log.debug("discovery served from cache", {
      context: {
        cwd,
        includeCommands,
        expiresInMs: cached.expiresAt - Date.now(),
      },
    });
    return cached.discovery;
  }
  log.info("discovering with a one-shot adapter", {
    context: { cwd, includeCommands },
  });
  const startedAt = Date.now();
  const discovery = runProbe(processes, context);
  discoveries.set(key, {
    discovery,
    cwd,
    expiresAt: Date.now() + CATALOG_TTL_MS,
  });
  // A failure is not an answer worth reusing: an adapter that was still starting, or a provider
  // the user is in the middle of configuring, must not keep the picker broken for the whole window.
  // Commands that never arrived are an answer, and are kept like one.
  void discovery.then(
    (discovered) => {
      log.info("discovery completed", {
        context: {
          cwd,
          durationMs: Date.now() - startedAt,
          models: discovered.models.map((model) => model.id),
          commands: discovered.commands?.length,
        },
      });
    },
    (error) => {
      log.warn("discovery failed; answer not cached", {
        context: { cwd, durationMs: Date.now() - startedAt },
        error,
      });
      if (discoveries.get(key)?.discovery === discovery) {
        discoveries.delete(key);
      }
    },
  );
  return discovery;
}

/** Spells the whole input but the deadline as one key; Skills only matter when commands do. */
function discoveryKey(context: AgentDiscoveryContext): string {
  const { cwd, includeCommands, skills } = context;
  return JSON.stringify(
    includeCommands
      ? [
        cwd,
        true,
        skills?.readRoots ?? null,
        skills?.directories ?? null,
        skills?.revision ?? null,
      ]
      : [cwd, false],
  );
}

/**
 * Runs one throwaway `claude-agent-acp` and reads the model selector, and when wanted the
 * commands, out of a session it creates.
 *
 * The commands are the session's first `available_commands_update`, which may arrive before or
 * after `session/new` answers; the wait for it is the SDK's, ending at Ora's cap or where the
 * cleanup reserve before the deadline begins. No report leaves the commands out — unknown — which
 * is not the empty list an agent that reports none sends. The session is set up with the Skills a
 * real one would get, and without MCP servers.
 *
 * The probe session is deleted when the adapter says it can be, inside the cleanup reserve the
 * handshake and the wait leave, and the process is killed either way.
 *
 * Failures propagate. Ora treats a failed discovery as a failed discovery rather than a failed
 * agent, so reporting one is cheap and honest, while answering with no models would make an
 * adapter that could not start indistinguishable from one that genuinely offers no pre-session
 * catalog.
 */
async function runProbe(
  processes: HostProcesses,
  context: AgentDiscoveryContext,
): Promise<AgentDiscovery> {
  const { cwd, includeCommands } = context;
  // Resolution failures — the adapter not on PATH, a pin naming nothing — are raised here as the
  // classified errors Ora acts on, before any probe exists to blur them into a timeout. The
  // directory is the child's own cwd, exactly as the live bridge spawns it, so discovery cannot
  // resolve a different project than a session would.
  const child = await spawnClaude(processes, { cwd });
  // The handshake must leave the cleanup reserve before Ora's deadline untouched.
  const probe = AcpProbe.attach(
    child,
    Math.min(
      Date.now() + PROBE_BUDGET_MS,
      context.deadline - AGENT_DISCOVERY_CLEANUP_RESERVE_MS,
    ),
  );
  try {
    // Watched before `session/new` is sent: a report that arrives ahead of its answer counts.
    const report = includeCommands
      ? probe.notification(isCommandReport)
      : undefined;
    // Ending the probe rejects a report nobody waited for; that is not an error worth surfacing.
    void report?.catch(() => {});
    const initialized = await probe.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // An agent only reports config options to a client that advertises them, so this one
      // declaration is what makes the model selector appear at all. Nothing else is claimed: the
      // probe has no filesystem to lend and no user to prompt.
      clientCapabilities: { session: { configOptions: {} } },
    });
    const session = await probe.request("session/new", {
      cwd,
      mcpServers: [],
      ...skillSessionSetup(
        context.skills,
        supportsAdditionalDirectories(initialized),
      ),
    });
    const models = modelsFrom(configOptionsOf(session));
    const commands = report === undefined
      ? undefined
      : commandsFrom(await waitForAgentCommands(context, report));
    await deleteProbeSession(probe, initialized, session, context.deadline);
    return commands === undefined ? { models } : { models, commands };
  } finally {
    await probe.close();
  }
}

/** Recognizes the ACP update that lists a session's commands. */
function isCommandReport(params: JsonValue): boolean {
  return readString(readRecord(params, "update") ?? {}, "sessionUpdate") ===
    "available_commands_update";
}

/**
 * Turns one command report into Ora's list, in the agent's order.
 *
 * `undefined` — no report in time — stays unknown. An entry missing its name or description is
 * dropped alone; the rest of the report still stands.
 */
function commandsFrom(
  report: JsonValue | undefined,
): AgentCommand[] | undefined {
  if (report === undefined) {
    return undefined;
  }
  const listed = readRecord(report, "update")?.availableCommands;
  if (!Array.isArray(listed)) {
    return undefined;
  }
  return listed.flatMap((entry): AgentCommand[] => {
    const name = readString(entry, "name");
    const description = readString(entry, "description");
    if (name === undefined || description === undefined) {
      return [];
    }
    const inputHint = readString(readRecord(entry, "input") ?? {}, "hint");
    return [
      inputHint === undefined
        ? { name, description }
        : { name, description, inputHint },
    ];
  });
}

/** Reports whether the agent's initialize answer accepts `additionalDirectories` on a session. */
function supportsAdditionalDirectories(initialized: JsonValue): boolean {
  const capabilities = readRecord(
    readRecord(initialized, "agentCapabilities"),
    "sessionCapabilities",
  );
  return capabilities !== undefined &&
    capabilities.additionalDirectories !== undefined;
}

/**
 * Removes the session the probe created, when the adapter supports removing one.
 *
 * Killing the process already ends the session as far as this plugin is concerned, but an adapter
 * that persists its sessions would otherwise collect one empty conversation per probe in the user's
 * own history. It is gated on the capability rather than sent unconditionally, because an adapter
 * that does not serve `session/delete` would earn a `method_not_found` on every discovery and clean
 * up nothing. Best effort either way — a failure is not a discovery failure, and the answer has
 * already been read.
 */
async function deleteProbeSession(
  probe: AcpProbe,
  initialized: JsonValue,
  session: JsonValue,
  deadline: number,
): Promise<void> {
  const sessionId = readString(session, "sessionId");
  if (sessionId === undefined || !supportsSessionDelete(initialized)) {
    return;
  }
  try {
    // The cleanup reserve before Ora's deadline is this request's to use.
    await probe.request("session/delete", { sessionId }, deadline);
  } catch (error) {
    log.debug("probe session was not deleted", {
      context: { sessionId },
      error,
    });
  }
}

/** Reports whether the agent advertised `session/delete` in its initialize response. */
function supportsSessionDelete(initialized: JsonValue): boolean {
  const capabilities = readRecord(
    readRecord(initialized, "agentCapabilities"),
    "sessionCapabilities",
  );
  return readRecord(capabilities, "delete") !== undefined;
}

/**
 * Picks the model selector out of a session's config options and flattens it into Ora's list.
 *
 * The choice mirrors how Ora reads the same options for its in-session picker, so the models a
 * user sees before starting a session are the models they will see inside one: prefer the option
 * the agent categorised as `model`, and otherwise accept a lone selector, since `category` is a UX
 * hint the protocol says clients must tolerate missing. An agent offering no selector yields an
 * empty list, which Ora accepts — its models then arrive with the session instead.
 */
function modelsFrom(configOptions: JsonValue[]): AgentModel[] {
  const selects = configOptions.filter(isSelectOption);
  const option = selects.find((select) => select.category === "model") ??
    (selects.length === 1 ? selects[0] : undefined);
  if (option === undefined) {
    return [];
  }
  const currentValue = readString(option, "currentValue");
  return selectableValues(option).map((value) => ({
    id: value.value,
    displayName: value.name,
    default: value.value === currentValue,
  }));
}

/** One selectable value of an ACP `select` config option. */
interface SelectValue {
  value: string;
  name: string;
}

/**
 * Flattens the two shapes an ACP selector's values take: a flat list, or a list of named groups.
 *
 * Group headers carry no value of their own and are dropped: Ora's pre-session list is flat, and a
 * group name is presentation the in-session picker renders from the same options later.
 */
function selectableValues(option: { [key: string]: JsonValue }): SelectValue[] {
  const options = option.options;
  if (!Array.isArray(options)) {
    return [];
  }
  return options.flatMap((entry): SelectValue[] => {
    if (!isRecord(entry)) {
      return [];
    }
    if (Array.isArray(entry.options)) {
      return entry.options.filter(isRecord).flatMap(toSelectValue);
    }
    return toSelectValue(entry);
  });
}

/** Keeps one option value only when it carries both halves Ora's picker needs. */
function toSelectValue(entry: { [key: string]: JsonValue }): SelectValue[] {
  const value = readString(entry, "value");
  const name = readString(entry, "name");
  return value === undefined ? [] : [{ value, name: name ?? value }];
}

/** Reads the config options off a `session/new` result, tolerating an agent that sends none. */
function configOptionsOf(session: JsonValue): JsonValue[] {
  if (!isRecord(session) || !Array.isArray(session.configOptions)) {
    return [];
  }
  return session.configOptions;
}

/** Narrows one config option to a `select`, the only kind that can carry a model catalog. */
function isSelectOption(
  option: JsonValue,
): option is { [key: string]: JsonValue } {
  return isRecord(option) && option.type === "select";
}

function readRecord(
  value: JsonValue | undefined,
  key: string,
): { [key: string]: JsonValue } | undefined {
  if (value === undefined || !isRecord(value)) {
    return undefined;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}

function readString(value: JsonValue, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
