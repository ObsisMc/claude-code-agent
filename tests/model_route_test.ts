import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, join } from "@std/path";
import {
  AGENT_UNUSABLE,
  type AgentModelContext,
  createLogger,
  createStderrLogSink,
  type HostChildProcessOptions,
  type HostProcesses,
  HostRequestError,
  INVALID_PARAMS,
  type JsonValue,
} from "@ora-space/plugin-sdk";
import { startClaude } from "../src/handlers/lifecycle.ts";
import { listAgentModels } from "../src/handlers/models.ts";
import {
  ClaudeClient,
  type SpawnedProcess,
} from "../src/services/claude-client.ts";
import { bundledAdapterPath } from "../src/services/bundled-binary.ts";
import { BIN_ENV_VAR } from "../src/services/command.ts";
import { installLogger } from "../src/services/log.ts";
import { modelRoute } from "../src/services/model-route.ts";

const TOKEN = "synthetic-temporary-token";

/**
 * The CLI resolver compiled into the adapter binary. It is plain Node ESM, loaded through a
 * computed specifier so `deno check` does not follow it into `node:` typings this repository does
 * not install; the test still runs the module itself.
 */
const {
  BIN_ENV_VAR: CLI_BIN_ENV_VAR,
  BUNDLED_ONLY_ENV_VAR,
  resolveClaudeCli,
} = await import(
  String(new URL("../scripts/resolve-claude-cli.mjs", import.meta.url))
) as {
  BIN_ENV_VAR: string;
  BUNDLED_ONLY_ENV_VAR: string;
  resolveClaudeCli: (options: {
    env: Record<string, string>;
    execPath: string;
    claudeBinaryName: string;
    warn: (message: string) => void;
  }) => { path: string; source: string };
};

/** The frozen context a Node hands this plugin for one platform-model execution. */
function context(
  overrides: Partial<AgentModelContext> = {},
): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.claude",
      pluginVersion: "0.4.0",
      // Whatever runs the tests is the target the Node froze this configuration for.
      target: Deno.build.target,
      packageSha256: "a".repeat(64),
      schemaVersion: 2,
      declarationFingerprint: "b".repeat(64),
      adapterVersion: 1,
      configurationRevision: 7,
      settingsJson: "{}",
      protocol: "anthropic-messages",
      model: {
        id: "team/claude",
        name: "Team Claude",
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    },
    proxyBaseUrl: "https://gateway.internal:8443/runtime/anthropic/v1",
    token: TOKEN,
    ...overrides,
  };
}

/** The routing a route puts in both the spawn environment and the session settings. */
const ROUTING = {
  ANTHROPIC_BASE_URL: "https://gateway.internal:8443/runtime/anthropic",
  ANTHROPIC_AUTH_TOKEN: "acp-proxy",
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

/** The flag settings every session of a platform route starts with. */
const SESSION_SETTINGS = { apiKeyHelper: "", env: ROUTING };

Deno.test("a frozen context becomes one pinned Messages route", () => {
  assertEquals(modelRoute(context()), {
    applied: {
      adapterVersion: 1,
      declarationFingerprint: "b".repeat(64),
      configurationRevision: 7,
    },
    model: { id: "team/claude", name: "Team Claude" },
    baseUrl: "https://gateway.internal:8443/runtime/anthropic",
    token: TOKEN,
    environment: {
      ...ROUTING,
      ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${TOKEN}`,
      ANTHROPIC_MODEL: "team/claude",
      ANTHROPIC_SMALL_FAST_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "team/claude",
      CLAUDE_CODE_SUBAGENT_MODEL: "team/claude",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ORA_CLAUDE_BUNDLED_CLI_ONLY: "1",
    },
    settings: SESSION_SETTINGS,
  });
});

Deno.test("the token is in the spawn environment and never in the session settings", () => {
  const route = modelRoute(context());
  const carriers = Object.entries(route.environment)
    .filter(([, value]) => value.includes(TOKEN))
    .map(([name]) => name);
  assertEquals(carriers, ["ANTHROPIC_CUSTOM_HEADERS"]);
  // The CLI receives these settings as a `--settings` argument, which anyone listing processes
  // can read.
  assertEquals(JSON.stringify(route.settings).includes(TOKEN), false);
});

Deno.test("configurations this release cannot apply are refused without echoing the token", () => {
  const refused: AgentModelContext[] = [
    context({
      configuration: {
        ...context().configuration,
        protocol: "openai-completions",
      },
    }),
    context({
      configuration: {
        ...context().configuration,
        settingsJson: '{"model":"opus"}',
      },
    }),
    context({
      configuration: {
        ...context().configuration,
        pluginId: "official/ora-space.opencode",
      },
    }),
    context({
      configuration: {
        ...context().configuration,
        target: Deno.build.target === "x86_64-unknown-linux-gnu"
          ? "aarch64-unknown-linux-gnu"
          : "x86_64-unknown-linux-gnu",
      },
    }),
    context({
      configuration: {
        ...context().configuration,
        model: { ...context().configuration.model, maxTokens: 0 },
      },
    }),
    // A header value cannot carry these; the adapter would only fail later, retryably.
    context({ token: `${TOKEN}\r\nx-other: 1` }),
    context({ token: `${TOKEN}\u0000` }),
    context({ proxyBaseUrl: "http://gateway.internal/runtime/anthropic/v1" }),
    context({ proxyBaseUrl: "https://gateway.internal/runtime/anthropic" }),
    context({ proxyBaseUrl: "https://gateway.internal/v1?redirect=1" }),
  ];
  for (const input of refused) {
    let caught: unknown;
    try {
      modelRoute(input);
    } catch (error) {
      caught = error;
    }
    assertEquals((caught as { code?: number }).code, INVALID_PARAMS);
    assertEquals(String((caught as Error).message).includes(TOKEN), false);
  }
});

Deno.test("a platform start spawns the adapter on its route and sends it nothing", async () => {
  const adapter = new ScriptedAdapter();
  const forwarded: JsonValue[] = [];
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
    onAcpFrame: (frame) => forwarded.push(frame),
  });
  const applied = await startClaude(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  });
  assertEquals(applied, modelRoute(context()).applied);
  assertEquals(adapter.environments, [modelRoute(context()).environment]);
  assertEquals([client.running, client.ready], [true, true]);
  // No request of this bridge's own carries the token, or anything else, into the adapter.
  assertEquals(adapter.written, []);
  adapter.emit({ jsonrpc: "2.0", id: 1, result: {} });
  await waitFor(() => forwarded.length === 1);
  assertEquals(forwarded, [{ jsonrpc: "2.0", id: 1, result: {} }]);
  await client.stop();
  assertEquals(client.ready, false);
});

Deno.test("an Effect restart spawns the adapter on the same route", async () => {
  const adapter = new ScriptedAdapter();
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
  });
  await startClaude(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  });
  await client.start("/workspace");
  assertEquals(adapter.environments, [
    modelRoute(context()).environment,
    modelRoute(context()).environment,
  ]);
  assertEquals(client.ready, true);
  await client.stop();
});

Deno.test("a local start keeps the adapter's own routing and confirms nothing", async () => {
  const adapter = new ScriptedAdapter();
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
  });
  const applied = await startClaude(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
  });
  assertEquals(applied, undefined);
  assertEquals(adapter.environments, [{}]);
  assertEquals(adapter.written, []);
  await client.stop();
});

Deno.test("a client cannot replace, drop or re-authenticate the platform route", async () => {
  const { adapter, client, forwarded } = await platformClient();
  for (
    const [id, method] of [
      [11, "authenticate"],
      [12, "logout"],
      [13, "auth/logout"],
      [14, "providers/set"],
      [15, "providers/disable"],
      [16, "providers/list"],
      [17, "_providers/set"],
    ] as const
  ) {
    await client.writeAcp({
      jsonrpc: "2.0",
      id,
      method,
      params: { providerId: "main", baseUrl: "https://other.invalid" },
    });
  }
  // A notification has nobody to answer and is simply not delivered.
  await client.writeAcp({ jsonrpc: "2.0", method: "providers/disable" });
  assertEquals(adapter.written.length, 0);
  assertEquals(
    forwarded.map((frame) => (frame as { id: number }).id),
    [11, 12, 13, 14, 15, 16, 17],
  );
  for (const frame of forwarded) {
    assertEquals((frame as { error: { code: number } }).error.code, -32601);
  }
  await client.stop();
});

Deno.test("a client can only ever select the frozen model", async () => {
  const { adapter, client, forwarded } = await platformClient();
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 1,
    method: "session/set_model",
    params: { sessionId: "s1", modelId: "opus" },
  });
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 2,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "model", value: "sonnet" },
  });
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 3,
    method: "session/set_model",
    params: { sessionId: "s1", modelId: "team/claude" },
  });
  // Re-selecting the frozen model is a no-op answered with what the session last reported.
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 4,
    method: "session/load",
    params: { sessionId: "s1", cwd: "/workspace", mcpServers: [] },
  });
  const options = [{ id: "mode", currentValue: "default", options: [] }];
  adapter.emit({ jsonrpc: "2.0", id: 4, result: { configOptions: options } });
  await waitFor(() => forwarded.length === 4);
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 5,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "model", value: "team/claude" },
  });
  // Every other option still reaches the adapter.
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 6,
    method: "session/set_config_option",
    params: { sessionId: "s1", configId: "mode", value: "plan" },
  });
  assertEquals(
    adapter.written.map((frame) => (frame as { id: string | number }).id),
    [4, 6],
  );
  assertEquals(forwarded[0], {
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32602,
      message: "this execution is fixed to the model team/claude",
    },
  });
  assertEquals(
    (forwarded[1] as { error: { code: number } }).error.code,
    -32602,
  );
  assertEquals(forwarded[2], { jsonrpc: "2.0", id: 3, result: {} });
  assertEquals(forwarded[4], {
    jsonrpc: "2.0",
    id: 5,
    result: { configOptions: options },
  });
  await client.stop();
});

Deno.test("session options cannot choose another model, CLI or environment", async () => {
  const { adapter, client } = await platformClient();
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "/workspace",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            model: "opus",
            fallbackModel: "sonnet",
            env: { ANTHROPIC_MODEL: "opus" },
            settings: { model: "opus" },
            extraArgs: { model: "opus" },
            executable: "node",
            executableArgs: ["--inspect"],
            pathToClaudeCodeExecutable: "/tmp/claude",
            maxTurns: 3,
          },
        },
        other: true,
      },
    },
  });
  assertEquals(adapter.written[0], {
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "/workspace",
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: { maxTurns: 3, settings: SESSION_SETTINGS },
        },
        other: true,
      },
    },
  });
  await client.stop();
});

Deno.test("every session setup carries the route's settings, with or without options", async () => {
  const { adapter, client } = await platformClient();
  const setups: [string, JsonValue][] = [
    ["session/new", { cwd: "/workspace", mcpServers: [] }],
    ["session/load", { sessionId: "s1", cwd: "/workspace", mcpServers: [] }],
    ["session/resume", {
      sessionId: "s1",
      cwd: "/workspace",
      _meta: { claudeCode: { options: { settings: "./elsewhere.json" } } },
    }],
    ["session/fork", {
      sessionId: "s1",
      cwd: "/workspace",
      _meta: { claudeCode: { vertex: true } },
    }],
  ];
  for (const [index, [method, params]] of setups.entries()) {
    await client.writeAcp({ jsonrpc: "2.0", id: index, method, params });
  }
  assertEquals(adapter.written.length, setups.length);
  for (const frame of adapter.written) {
    const meta = (frame as {
      params: { _meta: { claudeCode: { options: { settings: JsonValue } } } };
    }).params._meta;
    assertEquals(meta.claudeCode.options.settings, SESSION_SETTINGS);
  }
  // What the caller put beside the options is kept.
  assertEquals(
    (adapter.written[3] as {
      params: { _meta: { claudeCode: { vertex: boolean } } };
    }).params._meta.claudeCode.vertex,
    true,
  );
  assertEquals(JSON.stringify(adapter.written).includes(TOKEN), false);
  await client.stop();
});

Deno.test("a local start passes every ACP frame through untouched", async () => {
  const adapter = new ScriptedAdapter();
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
  });
  await startClaude(client, { cwd: "/workspace", hostVersion: "1.0.0" });
  const frame = { jsonrpc: "2.0", id: 1, method: "providers/set", params: {} };
  await client.writeAcp(frame);
  assertEquals(adapter.written, [frame]);
  await client.stop();
});

Deno.test("a platform route spawns only the bundled adapter, ignoring a pin and PATH", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const client = new ClaudeClient();
  client.attachProcesses({
    spawn: (options) => {
      spawns.push(options);
      return Promise.reject(
        new HostRequestError("package_command_missing", "not in this package"),
      );
    },
  });
  const previous = Deno.env.get(BIN_ENV_VAR);
  Deno.env.set(BIN_ENV_VAR, "/usr/local/bin/claude-agent-acp");
  try {
    const error = await assertRejects(() =>
      startClaude(client, {
        cwd: "/workspace",
        hostVersion: "1.0.0",
        modelContext: context(),
      })
    );
    // Not retried as a missing install: the package itself cannot serve a platform route.
    assertEquals((error as { code?: number }).code, AGENT_UNUSABLE);
  } finally {
    if (previous === undefined) Deno.env.delete(BIN_ENV_VAR);
    else Deno.env.set(BIN_ENV_VAR, previous);
  }
  assertEquals(spawns.length, 1);
  assertEquals(spawns[0].packageCommand, bundledAdapterPath());
  assertEquals(Object.hasOwn(spawns[0], "command"), false);
  assertEquals(spawns[0].env?.ORA_CLAUDE_BUNDLED_CLI_ONLY, "1");
});

Deno.test("the compiled adapter runs only its bundled CLI on a platform route", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { execPath, bundled, pinned, localDir } = await cliLayout(root);
    const resolve = (env: Record<string, string>) =>
      resolveClaudeCli({
        env,
        execPath,
        claudeBinaryName: "claude",
        warn: () => {},
      });
    const everything = { [CLI_BIN_ENV_VAR]: pinned, PATH: localDir };
    // Locally the pin outranks the bundled copy.
    assertEquals(resolve(everything), { path: pinned, source: "pinned" });
    // On a route neither the pin nor a local install is ever read.
    assertEquals(
      resolve({ ...everything, [BUNDLED_ONLY_ENV_VAR]: "1" }),
      { path: bundled, source: "bundled" },
    );
    await Deno.remove(bundled);
    assertEquals(resolve(everything).source, "pinned");
    assertThrows(
      () => resolve({ ...everything, [BUNDLED_ONLY_ENV_VAR]: "1" }),
      Error,
      BUNDLED_ONLY_ENV_VAR,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("every model selector the adapter reports offers only the frozen model", async () => {
  const { adapter, client, forwarded } = await platformClient();
  assertEquals(client.frozenModel, { id: "team/claude", name: "Team Claude" });
  const mode = { id: "mode", category: "mode", currentValue: "default" };
  const picker = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Default" },
      { value: "opus", name: "Opus" },
      { value: "sonnet", name: "Sonnet" },
    ],
  };
  const frozen = {
    ...picker,
    currentValue: "team/claude",
    options: [{ value: "team/claude", name: "Team Claude" }],
  };
  adapter.emit({
    jsonrpc: "2.0",
    id: 1,
    result: {
      sessionId: "s1",
      configOptions: [mode, picker],
      models: {
        currentModelId: "default",
        availableModels: [{ modelId: "opus", name: "Opus" }],
      },
    },
  });
  adapter.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s2",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [picker],
      },
    },
  });
  await waitFor(() => forwarded.length === 2);
  assertEquals(forwarded[0], {
    jsonrpc: "2.0",
    id: 1,
    result: {
      sessionId: "s1",
      configOptions: [mode, frozen],
      models: {
        currentModelId: "team/claude",
        availableModels: [{ modelId: "team/claude", name: "Team Claude" }],
      },
    },
  });
  assertEquals(forwarded[1], {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s2",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [frozen],
      },
    },
  });
  // The no-op answer repeats the narrowed set, never the adapter's own list.
  await client.writeAcp({
    jsonrpc: "2.0",
    id: 2,
    method: "session/set_config_option",
    params: { sessionId: "s2", configId: "model", value: "team/claude" },
  });
  assertEquals(forwarded[2], {
    jsonrpc: "2.0",
    id: 2,
    result: { configOptions: [frozen] },
  });
  await client.stop();
});

Deno.test("model discovery on a platform route answers the frozen model without a probe", async () => {
  const { client } = await platformClient();
  const spawns: HostChildProcessOptions[] = [];
  const processes: HostProcesses = {
    spawn: (options) => {
      spawns.push(options);
      return Promise.reject(new Error("a probe must not start"));
    },
  };
  assertEquals(await listAgentModels(client, processes, "/workspace"), [
    { id: "team/claude", displayName: "Team Claude", default: true },
  ]);
  assertEquals(spawns, []);
  await client.stop();
  // Without a route the same call is discovery, which needs the host's processes.
  assertThrows(
    () => listAgentModels(new ClaudeClient(), undefined, "/workspace"),
    Error,
    "before activation",
  );
});

Deno.test("adapter errors reach Ora with their code but without their text", async () => {
  const { adapter, client, forwarded } = await platformClient();
  adapter.emit({
    jsonrpc: "2.0",
    id: 7,
    error: {
      code: -32000,
      message: "401 from https://other.invalid: bad key",
      data: { headers: { "x-api-key": "leaked" } },
    },
  });
  adapter.emit({ jsonrpc: "2.0", id: 8, error: "not an object" });
  await waitFor(() => forwarded.length === 2);
  assertEquals(forwarded, [
    {
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32000,
        message: "The Claude agent could not complete the request",
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      error: {
        code: -32603,
        message: "The Claude agent could not complete the request",
      },
    },
  ]);
  await client.stop();
});

Deno.test("the token and gateway address never leave the adapter's frames", async () => {
  const { adapter, client, forwarded } = await platformClient();
  adapter.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text:
            `API Error calling https://gateway.internal:8443/runtime/anthropic/v1/messages with ${TOKEN}; gateway.internal unreachable`,
        },
      },
    },
  });
  await waitFor(() => forwarded.length === 1);
  assertEquals(
    (forwarded[0] as {
      params: { update: { content: { text: string } } };
    }).params.update.content.text,
    "API Error calling [redacted]/v1/messages with [redacted]; [redacted] unreachable",
  );
  await client.stop();
});

Deno.test("the adapter's own text never reaches the log on a platform route", async () => {
  const records: string[] = [];
  installLogger(createLogger({ write: (line) => records.push(line) }));
  try {
    const { adapter, client } = await platformClient();
    // What a failed request looks like once the CLI and adapter have echoed it: the upstream's
    // body and address, and paths of the host this runs on.
    const leaks = [
      'upstream host=api.provider.example path=/v1/messages body={"error":"overloaded","request_id":"req_123"}',
      "/home/node-user/.cache/ora/workspaces/7f3a",
    ];
    adapter.emitLine(`not json ${leaks.join(" ")}`);
    adapter.emitStderr(
      "[providers/set] apiType=anthropic baseUrl=https://gateway.internal:8443/runtime/anthropic",
    );
    adapter.emitStderr(`API Error: 503 ${leaks.join(" ")} ${TOKEN}`);
    adapter.closeStderr();
    await waitFor(() =>
      records.some((record) => record.includes("non-JSON")) &&
      records.some((record) => record.includes("suppressed"))
    );
    const text = records.join("\n");
    for (const secret of [TOKEN, "gateway.internal", ...leaks]) {
      assertEquals(text.includes(secret), false, secret);
    }
    assertEquals(text.includes('"lines":2'), true);
    await client.stop();
  } finally {
    installLogger(createLogger(createStderrLogSink()));
  }
});

Deno.test("a local adapter's diagnostics are kept verbatim", async () => {
  const records: string[] = [];
  installLogger(createLogger({ write: (line) => records.push(line) }));
  try {
    const adapter = new ScriptedAdapter();
    const client = new ClaudeClient({
      spawn: (_cwd, env) => adapter.spawn(env),
    });
    await client.start("/workspace");
    adapter.emitStderr("[claude-agent-acp] using the local CLI");
    adapter.emitLine("not json from a local pairing");
    await waitFor(() =>
      records.some((record) => record.includes("using the local CLI")) &&
      records.some((record) => record.includes("from a local pairing"))
    );
    await client.stop();
  } finally {
    installLogger(createLogger(createStderrLogSink()));
  }
});

/** A bundled CLI beside a fake adapter, a pinned one, and one on a fake PATH. */
async function cliLayout(root: string) {
  const files = {
    execPath: join(root, "package", "claude-agent-acp"),
    bundled: join(root, "package", "claude"),
    pinned: join(root, "pinned", "claude"),
    local: join(root, "local", "claude"),
  };
  for (const path of Object.values(files)) {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, "");
  }
  return { ...files, localDir: dirname(files.local) };
}

async function platformClient() {
  const adapter = new ScriptedAdapter();
  const forwarded: JsonValue[] = [];
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
    onAcpFrame: (frame) => forwarded.push(frame),
  });
  await startClaude(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  });
  return { adapter, client, forwarded };
}

/** A `claude-agent-acp` stand-in that records what it was given and answers nothing itself. */
class ScriptedAdapter {
  readonly written: JsonValue[] = [];
  readonly environments: Record<string, string>[] = [];
  killed = 0;
  #stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  #stderr: ReadableStreamDefaultController<Uint8Array> | undefined;

  /** Spawns one generation; a later spawn supersedes the earlier one's stdout. */
  spawn(env: Record<string, string>): SpawnedProcess {
    this.environments.push(env);
    let ended: (() => void) | undefined;
    return {
      pid: 4321,
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => {
          for (const line of new TextDecoder().decode(chunk).split("\n")) {
            if (line.trim() === "") continue;
            this.written.push(JSON.parse(line) as JsonValue);
          }
        },
      }),
      stdout: new ReadableStream({
        start: (controller) => {
          this.#stdout = controller;
        },
      }),
      stderr: new ReadableStream({
        start: (controller) => {
          this.#stderr = controller;
        },
      }),
      exited: new Promise((resolve) => {
        ended = () => resolve();
      }),
      kill: () => {
        this.killed += 1;
        this.#stdout?.close();
        this.#stderr?.close();
        ended?.();
      },
    };
  }

  /** Closes the current generation's stderr, as an adapter that exits does. */
  closeStderr(): void {
    this.#stderr?.close();
  }

  /** Writes one diagnostic line to the current generation's stderr. */
  emitStderr(line: string): void {
    this.#stderr?.enqueue(new TextEncoder().encode(`${line}\n`));
  }

  /** Writes one raw line to the current generation's stdout. */
  emitLine(line: string): void {
    this.#stdout?.enqueue(new TextEncoder().encode(`${line}\n`));
  }

  /** Writes one NDJSON frame to the current generation's stdout. */
  emit(frame: JsonValue): void {
    this.#stdout?.enqueue(
      new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
    );
  }
}

/** Polls a condition the bridge settles asynchronously, failing after a bounded wait. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was never met");
}
