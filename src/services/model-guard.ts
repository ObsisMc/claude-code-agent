import type { JsonValue } from "@ora-space/plugin-sdk";

/** The one model a platform-model execution may use, as the gateway and Ora name it. */
export interface FrozenModel {
  readonly id: string;
  readonly name: string;
}

/** What the bridge does with one frame Ora sent towards the adapter. */
export type InboundDecision =
  /** Write this frame, possibly rewritten, into the adapter. */
  | { readonly forward: JsonValue }
  /** Answer Ora with this frame instead; the adapter never sees the request. */
  | { readonly reply: JsonValue }
  /** A notification nobody may send in this execution; there is nothing to answer. */
  | { readonly drop: true };

/** JSON-RPC "method not found": these methods do not exist for a frozen execution. */
const METHOD_NOT_AVAILABLE = -32601;
/** JSON-RPC "invalid params": a model other than the frozen one was asked for. */
const MODEL_FROZEN = -32602;

/**
 * Methods that would hand the adapter another upstream, another credential, or none at all.
 *
 * `providers/set` would replace the route this plugin applied, while `providers/disable` and
 * `logout` clear it and send Claude Code back to its native routing and login. `authenticate`
 * installs a gateway of the caller's choosing. `providers/list` is read-only, but nothing Ora
 * needs is in it, and the route is this plugin's business alone.
 */
function isRouteMutation(method: string): boolean {
  return method === "authenticate" || method === "logout" ||
    method.startsWith("auth/") || method.startsWith("_auth/") ||
    method.startsWith("providers/");
}

/**
 * Session options a client may put in `_meta.claudeCode.options` that choose the model, the CLI,
 * or the environment and settings Claude Code resolves both from.
 *
 * `claude-agent-acp` spreads the caller's options over its own and the caller's `env` over the
 * process environment, so a `model`, an `ANTHROPIC_MODEL` or a `--model` in `extraArgs` would
 * outrank the aliases this plugin pins. Every other option is left alone.
 */
const PINNED_SESSION_OPTIONS = [
  "model",
  "fallbackModel",
  "env",
  "settings",
  "extraArgs",
  "executable",
  "executableArgs",
  "pathToClaudeCodeExecutable",
];

/** Requests that create or restore a session, and therefore carry session options. */
const SESSION_SETUP = new Set([
  "session/new",
  "session/load",
  "session/resume",
  "session/fork",
]);

/**
 * Keeps one platform-model execution on its frozen route and model.
 *
 * The route itself is applied once, through `providers/set`; this class only keeps anyone else
 * from undoing it over ACP. It refuses the methods that could move the adapter to another
 * upstream or model, strips session options that would do the same, and remembers each session's
 * config options so re-selecting the frozen model can be answered without reaching the adapter.
 */
export class ModelGuard {
  readonly #model: FrozenModel;
  /** Ora's outstanding requests whose answer belongs to a session the request named. */
  readonly #pendingSessions = new Map<string, string>();
  /** The config options each session last reported, to answer a no-op model change. */
  readonly #configOptions = new Map<string, JsonValue[]>();

  constructor(model: FrozenModel) {
    this.#model = model;
  }

  /** Decides what happens to one frame Ora sent towards the adapter. */
  inbound(frame: JsonValue): InboundDecision {
    if (!isObject(frame) || typeof frame.method !== "string") {
      return { forward: frame };
    }
    const method = frame.method;
    const params = isObject(frame.params) ? frame.params : {};
    if (isRouteMutation(method)) {
      return refuse(
        frame,
        METHOD_NOT_AVAILABLE,
        `${method} is not available: this execution's model route is fixed`,
      );
    }
    if (method === "session/set_model") {
      return params.modelId === this.#model.id
        ? answer(frame, {})
        : refuse(frame, MODEL_FROZEN, this.#frozenMessage());
    }
    const sessionId = typeof params.sessionId === "string"
      ? params.sessionId
      : undefined;
    if (method === "session/set_config_option" && params.configId === "model") {
      const known = sessionId === undefined
        ? undefined
        : this.#configOptions.get(sessionId);
      // The only selectable value is the one already in effect, so choosing it changes nothing
      // and is answered with what the session last reported.
      return params.value === this.#model.id && known !== undefined
        ? answer(frame, { configOptions: known })
        : refuse(frame, MODEL_FROZEN, this.#frozenMessage());
    }
    if (sessionId !== undefined && hasId(frame)) {
      this.#pendingSessions.set(idKey(frame.id), sessionId);
    }
    if (SESSION_SETUP.has(method)) {
      return { forward: pinSessionOptions(frame, params) };
    }
    return { forward: frame };
  }

  /** Observes, and may rewrite, one frame the adapter sent before Ora sees it. */
  outbound(frame: JsonValue): JsonValue {
    if (!isObject(frame)) return frame;
    if (typeof frame.method === "string") {
      this.#observeUpdate(frame);
      return frame;
    }
    const sessionId = hasId(frame)
      ? this.#takePendingSession(frame.id)
      : undefined;
    if (!isObject(frame.result)) return frame;
    const owner = typeof frame.result.sessionId === "string"
      ? frame.result.sessionId
      : sessionId;
    if (owner !== undefined && Array.isArray(frame.result.configOptions)) {
      this.#configOptions.set(owner, frame.result.configOptions);
    }
    return frame;
  }

  /** A `config_option_update` replaces the whole set a session reports. */
  #observeUpdate(frame: { [key: string]: JsonValue }): void {
    if (frame.method !== "session/update" || !isObject(frame.params)) return;
    const update = frame.params.update;
    if (
      isObject(update) && Array.isArray(update.configOptions) &&
      typeof frame.params.sessionId === "string"
    ) {
      this.#configOptions.set(frame.params.sessionId, update.configOptions);
    }
  }

  #takePendingSession(id: string | number): string | undefined {
    const key = idKey(id);
    const sessionId = this.#pendingSessions.get(key);
    this.#pendingSessions.delete(key);
    return sessionId;
  }

  #frozenMessage(): string {
    return `this execution is fixed to the model ${this.#model.id}`;
  }
}

/** Drops the caller's model, CLI and environment choices from one session-setup request. */
function pinSessionOptions(
  frame: { [key: string]: JsonValue },
  params: { [key: string]: JsonValue },
): JsonValue {
  const meta = params._meta;
  if (!isObject(meta) || !isObject(meta.claudeCode)) return frame;
  const options = meta.claudeCode.options;
  if (!isObject(options)) return frame;
  if (!PINNED_SESSION_OPTIONS.some((key) => key in options)) return frame;
  const pinned = { ...options };
  for (const key of PINNED_SESSION_OPTIONS) delete pinned[key];
  return {
    ...frame,
    params: {
      ...params,
      _meta: { ...meta, claudeCode: { ...meta.claudeCode, options: pinned } },
    },
  };
}

function answer(
  frame: { [key: string]: JsonValue },
  result: JsonValue,
): InboundDecision {
  return hasId(frame)
    ? { reply: { jsonrpc: "2.0", id: frame.id, result } }
    : { drop: true };
}

function refuse(
  frame: { [key: string]: JsonValue },
  code: number,
  message: string,
): InboundDecision {
  return hasId(frame)
    ? { reply: { jsonrpc: "2.0", id: frame.id, error: { code, message } } }
    : { drop: true };
}

function hasId(
  frame: { [key: string]: JsonValue },
): frame is { [key: string]: JsonValue; id: string | number } {
  return typeof frame.id === "string" || typeof frame.id === "number";
}

/** Keeps `1` and `"1"` apart: JSON-RPC treats them as different ids. */
function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
