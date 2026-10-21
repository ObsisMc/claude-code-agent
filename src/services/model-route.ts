import {
  type AgentModelApplied,
  type AgentModelContext,
  INVALID_PARAMS,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import type { FrozenModel } from "./model-guard.ts";

/** The adapter's single client-managed provider slot, as `providers/list` names it. */
const PROVIDER_ID = "main";

/** This plugin's id without its namespace; the host registers it under the namespace it owns. */
export const PLUGIN_ID = "ora-space.claude";

/**
 * Bytes a header value cannot carry. The adapter would refuse such a token only when it lists the
 * gateway's models, as a failed preparation that a retry repeats forever.
 */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Everything one platform-model execution needs from this plugin, derived once at `agent/start`.
 *
 * `provider` becomes the adapter's `providers/set` call: the adapter puts that route into Claude
 * Code's programmatic settings tier with `apiKeyHelper` cleared, so a repository's
 * `.claude/settings.json` or a user setting cannot silently send the request, and the token in its
 * header, to another base URL. `environment` pins every model alias Claude Code resolves on its own
 * (the main model, the auxiliary small/fast model, subagents and the `opus`/`sonnet`/`haiku`
 * shortcuts) to the one frozen model; the gateway still refuses any other model id, so a setting
 * that overrides an alias fails closed instead of reaching a model nobody admitted.
 */
export interface ModelRoute {
  readonly applied: AgentModelApplied;
  /** The one model this execution may use; every selector and switch is held to it. */
  readonly model: FrozenModel;
  readonly provider: {
    readonly providerId: string;
    readonly apiType: "anthropic";
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly environment: Readonly<Record<string, string>>;
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
  return {
    applied: {
      adapterVersion: configuration.adapterVersion,
      declarationFingerprint: configuration.declarationFingerprint,
      configurationRevision: configuration.configurationRevision,
    },
    model: { id: model, name: configuration.model.name },
    provider: {
      providerId: PROVIDER_ID,
      apiType: "anthropic",
      baseUrl: proxy,
      // The gateway reads `x-api-key` first on its Messages route; the adapter's own placeholder
      // bearer token then never authenticates anything.
      headers: { "x-api-key": context.token },
    },
    environment: {
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
