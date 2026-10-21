import type {
  AgentModel,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import {
  AGENT_METHODS,
  INVALID_PARAMS,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import { AcpProbe } from "../services/acp-probe.ts";
import type { ClaudeClient } from "../services/claude-client.ts";
import { spawnClaude } from "../services/command.ts";
import { logger } from "../services/log.ts";

const log = logger("models");

/** The ACP revision this plugin speaks; the same one Ora declares on its own connection. */
const ACP_PROTOCOL_VERSION = 1;

/**
 * How long one workspace's answer is reused before Claude Code is asked again.
 *
 * Ora deliberately keeps no copy: discovery is on demand, so a picker that re-renders asks again,
 * and every ask costs an adapter start plus an ACP handshake. A short window collapses that burst
 * without outliving the reason a catalog changes — logging into a provider, or editing Claude
 * Code's config — which stays visible the next time the picker is opened.
 */
const CATALOG_TTL_MS = 5 * 60_000;

/** One workspace's in-flight or recent answer. */
interface CachedCatalog {
  models: Promise<AgentModel[]>;
  expiresAt: number;
}

const catalogs = new Map<string, CachedCatalog>();

/** Drops the catalog for one workspace so the next request probes the current adapter state. */
export function invalidateClaudeModels(cwd: string): void {
  catalogs.delete(cwd);
}

/** Drops every workspace catalog when this plugin generation is going away. */
export function invalidateAllClaudeModels(): void {
  catalogs.clear();
}

/**
 * Serves `agent/list_models`: the frozen model on a platform route, discovery everywhere else.
 *
 * A platform route offers exactly its frozen model. Probing would start an adapter on the host's
 * own credentials and routing — a run nobody admitted — and list what that finds (ADR D5).
 * Discovery is answered for the Workspace the host named, not for the directory `agent/start` was
 * given: that one is neutral, and a user can open pickers for a project this connection never ran
 * in.
 */
export function listAgentModels(
  client: Pick<ClaudeClient, "frozenModel">,
  processes: HostProcesses | undefined,
  cwd: string,
): Promise<AgentModel[]> {
  const frozen = client.frozenModel;
  if (frozen !== undefined) {
    return Promise.resolve([
      { id: frozen.id, displayName: frozen.name, default: true },
    ]);
  }
  if (processes === undefined) {
    throw new Error(`${AGENT_METHODS.listModels} was called before activation`);
  }
  return listClaudeModels(processes, cwd);
}

/**
 * Serves `agent/list_models` for one workspace by asking Claude Code's adapter itself.
 *
 * `claude-agent-acp` publishes its model choices in one place only: the `configOptions` an ACP
 * session carries — `default`, `sonnet`, `opus`, `haiku`, `fable` as of this writing. There is no
 * pre-session listing to read, so discovery has to hold a whole ACP conversation, which is why it
 * needs its own process rather than the connection Ora is reading; see {@link AcpProbe}. Those same
 * options still reach Ora unchanged from the live session, so the pre-session list this builds and
 * the in-session picker are two readings of one source rather than two sources that can disagree.
 *
 * A concurrent second call joins the promise already in flight rather than starting a second
 * adapter: Ora renders the agent picker and the workflow inspector independently, and both ask on
 * open.
 *
 * The directory is checked rather than assumed: a host predating the `cwd` parameter sends no
 * params at all, and this plugin cannot invent a workspace to answer for. Saying so is the whole
 * value — the alternative is a probe spawned against nothing, failing several seconds later with
 * an error about an adapter rather than about the host that asked.
 */
export function listClaudeModels(
  processes: HostProcesses,
  cwd: string,
): Promise<AgentModel[]> {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    log.warn("agent/list_models refused: no workspace cwd");
    throw new PluginMethodError(
      INVALID_PARAMS,
      "agent/list_models requires the cwd of the workspace to discover models for",
    );
  }
  const cached = catalogs.get(cwd);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    log.debug("model catalog served from cache", {
      context: { cwd, expiresInMs: cached.expiresAt - Date.now() },
    });
    return cached.models;
  }
  log.info("discovering models with a one-shot adapter", { context: { cwd } });
  const startedAt = Date.now();
  const models = discoverModels(processes, cwd);
  catalogs.set(cwd, { models, expiresAt: Date.now() + CATALOG_TTL_MS });
  // A failure is not an answer worth reusing: an adapter that was still starting, or a provider
  // the user is in the middle of configuring, must not keep the picker broken for the whole window.
  void models.then(
    (discovered) => {
      log.info("model discovery completed", {
        context: {
          cwd,
          durationMs: Date.now() - startedAt,
          models: discovered.map((model) => model.id),
        },
      });
    },
    (error) => {
      log.warn("model discovery failed; catalog not cached", {
        context: { cwd, durationMs: Date.now() - startedAt },
        error,
      });
      if (catalogs.get(cwd)?.models === models) {
        catalogs.delete(cwd);
      }
    },
  );
  return models;
}

/**
 * Runs one throwaway `claude-agent-acp` and reads the model selector out of a session it creates.
 *
 * The probe session is deleted when the adapter says it can be, and the process is killed either
 * way, so discovery leaves nothing behind in the user's session history.
 *
 * Failures propagate. Ora treats a failed `agent/list_models` as a failed discovery rather than a
 * failed agent, so reporting one is cheap and honest, while answering with an empty list would
 * make an adapter that could not start indistinguishable from one that genuinely offers no
 * pre-session catalog.
 */
async function discoverModels(
  processes: HostProcesses,
  cwd: string,
): Promise<AgentModel[]> {
  // Resolution failures — the adapter not on PATH, a pin naming nothing — are raised here as the
  // classified errors Ora acts on, before any probe exists to blur them into a timeout. The
  // directory is the child's own cwd, exactly as the live bridge spawns it, so discovery cannot
  // resolve a different project than a session would.
  const child = await spawnClaude(processes, { cwd });
  const probe = AcpProbe.attach(child);
  try {
    const initialized = await probe.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // An agent only reports config options to a client that advertises them, so this one
      // declaration is what makes the model selector appear at all. Nothing else is claimed: the
      // probe has no filesystem to lend and no user to prompt.
      clientCapabilities: { session: { configOptions: {} } },
    });
    const session = await probe.request("session/new", { cwd, mcpServers: [] });
    const models = modelsFrom(configOptionsOf(session));
    await deleteProbeSession(probe, initialized, session);
    return models;
  } finally {
    await probe.close();
  }
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
): Promise<void> {
  const sessionId = readString(session, "sessionId");
  if (sessionId === undefined || !supportsSessionDelete(initialized)) {
    return;
  }
  try {
    await probe.request("session/delete", { sessionId });
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
