import {
  type AgentModelApplied,
  type AgentModelContext,
  INVALID_PARAMS,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import type { FrozenModel } from "./model-guard.ts";

/** This plugin's id without its namespace; the host registers it under the namespace it owns. */
export const PLUGIN_ID = "ora-space.claude";

/**
 * Bytes a header value cannot carry. Claude Code would refuse such a token only when it sends its
 * first request, as a failed turn that a retry repeats forever.
 */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * The bearer Claude Code is given so it skips its own login check. The gateway authenticates the
 * `x-api-key` header first, so this value never authenticates anything; it is the same placeholder
 * the pinned adapter uses for a route of its own.
 */
const AUTH_TOKEN_PLACEHOLDER = "acp-proxy";

/**
 * Everything one platform-model execution needs from this plugin, derived once at `agent/start`.
 *
 * The route is split by what may be seen. `environment` is the adapter's spawn environment, which
 * Claude Code inherits: it alone carries the token, as the `x-api-key` header in
 * `ANTHROPIC_CUSTOM_HEADERS`, and only the execution's own identity can read it there.
 * `settings` goes into every session's `_meta.claudeCode.options.settings`, which the Claude Agent
 * SDK hands the CLI as a `--settings` argument that anyone listing processes can read; it holds
 * the routing without the token. As flag settings it outranks a repository's
 * `.claude/settings.json` and every user setting, so neither can point the token at another base
 * URL or restore another credential source; a setting that replaces the header only drops the
 * token, and the gateway refuses the request.
 *
 * `environment` also pins every model alias Claude Code resolves on its own (the main model, the
 * auxiliary small/fast model, subagents and the `opus`/`sonnet`/`haiku` shortcuts) to the one
 * frozen model; the gateway still refuses any other model id, so a setting that overrides an alias
 * fails closed instead of reaching a model nobody admitted.
 */
export interface ModelRoute {
  readonly applied: AgentModelApplied;
  /** The one model this execution may use; every selector and switch is held to it. */
  readonly model: FrozenModel;
  /** The gateway base URL Claude Code appends `/v1/messages` to. */
  readonly baseUrl: string;
  /** The temporary credential; it may appear in `environment` and nowhere else. */
  readonly token: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly settings: {
    readonly apiKeyHelper: string;
    readonly env: Readonly<Record<string, string>>;
  };
}

/**
 * Turns a frozen model context into this plugin's Claude Code route, refusing what it cannot apply.
 *
 * The declaration admits one `anthropic-messages` connection and no Settings fields, so any other
 * protocol, any Settings key, or a proxy that is not the platform's Messages endpoint is a
 * configuration this release does not know how to honour; starting anyway would run Claude Code on
 * whatever route it found by itself. A configuration frozen for another plugin or another target
 * is refused too: the Node checks both before it starts anything, and this costs one comparison.
 * The error never echoes the context, which carries the token.
 */
export function modelRoute(context: AgentModelContext): ModelRoute {
  const { configuration } = context;
  let settings: unknown;
  try {
    settings = JSON.parse(configuration.settingsJson);
  } catch {
    refuse();
  }
  const proxy = parseProxy(context.proxyBaseUrl);
  const { maxTokens } = configuration.model;
  if (
    configuration.protocol !== "anthropic-messages" ||
    configuration.pluginId.split("/").at(-1) !== PLUGIN_ID ||
    configuration.target !== Deno.build.target ||
    settings === null || typeof settings !== "object" ||
    Array.isArray(settings) || Object.keys(settings).length > 0 ||
    proxy === undefined || context.token.length === 0 ||
    CONTROL_CHARACTERS.test(context.token) ||
    !Number.isSafeInteger(maxTokens) || maxTokens <= 0
  ) {
    refuse();
  }
  const model = configuration.model.id;
  const routing = routingEnvironment(proxy);
  return {
    applied: {
      adapterVersion: configuration.adapterVersion,
      declarationFingerprint: configuration.declarationFingerprint,
      configurationRevision: configuration.configurationRevision,
    },
    model: { id: model, name: configuration.model.name },
    baseUrl: proxy,
    token: context.token,
    environment: {
      ...routing,
      ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${context.token}`,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      // The frozen model's own output bound; Claude Code would otherwise ask for its default.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      // Telemetry, error reporting, update checks and feedback surveys would otherwise leave the
      // sandbox for Anthropic's own endpoints, which the platform route does not cover.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      // Holds the adapter to the CLI bundled beside it: `ORA_CLAUDE_BIN` and a local install are
      // ignored, see `scripts/adapter-entry.mjs`.
      ORA_CLAUDE_BUNDLED_CLI_ONLY: "1",
    },
    settings: { apiKeyHelper: "", env: routing },
  };
}

/**
 * The routing Claude Code must use, none of it secret: the gateway, a placeholder bearer, and
 * every other upstream and credential source cleared.
 *
 * It is the reset the pinned adapter applies for a route of its own, so a host environment that
 * carries a shared key or a cloud-provider switch cannot pull the CLI elsewhere. It appears twice:
 * in the spawn environment, and in the flag settings that outrank what a repository sets.
 */
function routingEnvironment(baseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN_PLACEHOLDER,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_BEDROCK_BASE_URL: "",
    ANTHROPIC_VERTEX_BASE_URL: "",
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    ANTHROPIC_VERTEX_PROJECT_ID: "",
    CLOUD_ML_REGION: "",
    AWS_REGION: "",
  };
}

/**
 * Reduces the platform's Messages proxy to the base URL Claude Code appends `/v1/messages` to.
 *
 * Only an HTTPS URL without credentials, query or fragment whose path ends in `/v1` is accepted;
 * anything else is not the endpoint the Node was granted.
 */
function parseProxy(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || !url.pathname.endsWith("/v1")
  ) {
    return undefined;
  }
  return `${url.origin}${url.pathname.slice(0, -"/v1".length)}`;
}

/** Fails `agent/start` without describing the sensitive input. */
function refuse(): never {
  throw new PluginMethodError(
    INVALID_PARAMS,
    "this Claude release cannot apply the supplied model configuration",
  );
}
