import { assertEquals, assertRejects } from "@std/assert";
import {
  AGENT_UNUSABLE,
  type AgentModelContext,
  INVALID_PARAMS,
  type JsonValue,
} from "@ora-space/plugin-sdk";
import { startClaude } from "../src/handlers/lifecycle.ts";
import {
  ClaudeClient,
  type SpawnedProcess,
} from "../src/services/claude-client.ts";
import { modelRoute } from "../src/services/model-route.ts";

const TOKEN = "synthetic-temporary-token";

/** The frozen context a Node hands this plugin for one platform-model execution. */
function context(
  overrides: Partial<AgentModelContext> = {},
): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.claude",
      pluginVersion: "0.4.0",
      target: "x86_64-unknown-linux-gnu",
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

Deno.test("a frozen context becomes one pinned Messages route", () => {
  assertEquals(modelRoute(context()), {
    applied: {
      adapterVersion: 1,
      declarationFingerprint: "b".repeat(64),
      configurationRevision: 7,
    },
    provider: {
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.internal:8443/runtime/anthropic",
      headers: { "x-api-key": TOKEN },
    },
    environment: {
      ANTHROPIC_MODEL: "team/claude",
      ANTHROPIC_SMALL_FAST_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "team/claude",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "team/claude",
      CLAUDE_CODE_SUBAGENT_MODEL: "team/claude",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  });
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

Deno.test("a platform start is confirmed only after the adapter accepted its route", async () => {
  const adapter = new ScriptedAdapter("accept");
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
  // The token reaches the adapter only inside its own provider request, never its environment.
  assertEquals(
    Object.values(adapter.environments[0]).some((value) =>
      value.includes(TOKEN)
    ),
    false,
  );
  assertEquals(adapter.written, [{
    jsonrpc: "2.0",
    id: "ora-claude-model-route-1",
    method: "providers/set",
    params: {
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.internal:8443/runtime/anthropic",
      headers: { "x-api-key": TOKEN },
    },
  }]);
  // The adapter's answer belongs to this bridge; Ora's frames still pass through untouched.
  adapter.emit({ jsonrpc: "2.0", id: 1, result: {} });
  await waitFor(() => forwarded.length === 1);
  assertEquals(forwarded, [{ jsonrpc: "2.0", id: 1, result: {} }]);
  await client.stop();
});

Deno.test("an Effect restart reapplies the same route before the adapter counts as running", async () => {
  const adapter = new ScriptedAdapter("accept");
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
  });
  await startClaude(client, {
    cwd: "/workspace",
    hostVersion: "1.0.0",
    modelContext: context(),
  });
  await client.start("/workspace");
  assertEquals(
    adapter.written.map((frame) => (frame as { id: string }).id),
    ["ora-claude-model-route-1", "ora-claude-model-route-2"],
  );
  assertEquals(adapter.environments.length, 2);
  await client.stop();
});

Deno.test("a rejected route fails the start and stops the adapter", async () => {
  const adapter = new ScriptedAdapter("reject");
  const client = new ClaudeClient({
    spawn: (_cwd, env) => adapter.spawn(env),
  });
  const error = await assertRejects(() =>
    startClaude(client, {
      cwd: "/workspace",
      hostVersion: "1.0.0",
      modelContext: context(),
    })
  );
  assertEquals((error as { code?: number }).code, AGENT_UNUSABLE);
  assertEquals(String((error as Error).message).includes(TOKEN), false);
  assertEquals(client.running, false);
  assertEquals(adapter.killed, 1);
});

Deno.test("a local start keeps the adapter's own routing and confirms nothing", async () => {
  const adapter = new ScriptedAdapter("accept");
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

/**
 * A `claude-agent-acp` stand-in that answers `providers/set` and records what it was given.
 *
 * Only the provider request is answered; every other frame is recorded and left to the test.
 */
class ScriptedAdapter {
  readonly written: JsonValue[] = [];
  readonly environments: Record<string, string>[] = [];
  killed = 0;
  #stdout: ReadableStreamDefaultController<Uint8Array> | undefined;

  constructor(readonly answer: "accept" | "reject") {}

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
            const frame = JSON.parse(line) as { id?: string; method?: string };
            this.written.push(frame as JsonValue);
            if (frame.method === "providers/set") {
              this.emit(
                this.answer === "accept"
                  ? { jsonrpc: "2.0", id: frame.id ?? null, result: {} }
                  : {
                    jsonrpc: "2.0",
                    id: frame.id ?? null,
                    error: { code: -32602, message: `rejected ${TOKEN}` },
                  },
              );
            }
          }
        },
      }),
      stdout: new ReadableStream({
        start: (controller) => {
          this.#stdout = controller;
        },
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited: new Promise((resolve) => {
        ended = () => resolve();
      }),
      kill: () => {
        this.killed += 1;
        this.#stdout?.close();
        ended?.();
      },
    };
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
