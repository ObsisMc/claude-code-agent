import { assertEquals } from "@std/assert";
import {
  AGENT_DISCOVERY_CLEANUP_RESERVE_MS,
  AGENT_METHODS,
  type AgentDiscoverSkills,
  type AgentDiscoveryContext,
  type HostChildProcess,
  type HostChildProcessOptions,
  type HostProcesses,
  type JsonValue,
} from "@ora-space/plugin-sdk";
import { AGENT_METHOD_ROUTES } from "../src/base/agent-plugin.ts";
import { discoverClaude } from "../src/handlers/discovery.ts";

Deno.test("models come from the probe session's model config option", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent),
    modelsOnly(uniqueWorkspace()),
  );
  assertEquals(discovery, {
    models: [
      { id: "fast", displayName: "Fast", default: false },
      { id: "deep", displayName: "Deep", default: true },
      { id: "grouped", displayName: "Grouped", default: false },
    ],
  });
});

Deno.test("discovery without a workspace is refused rather than guessed", () => {
  const error = (() => {
    try {
      discoverClaude(fakeProcesses(defaultAcpAgent), modelsOnly(""));
      return undefined;
    } catch (thrown) {
      return thrown as { code?: number };
    }
  })();
  assertEquals(error?.code, -32602);
});

Deno.test("the plugin serves agent/discover", () => {
  // The SDK answers agent/list_models from the same method for hosts that only know that name.
  assertEquals(AGENT_METHOD_ROUTES.onDiscover, AGENT_METHODS.discover);
});

Deno.test("commands are the probe session's first report, in the agent's order", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], {
      after: commandReport([
        { name: "review", description: "Review the diff" },
        { name: "plan", description: "Plan a change", input: { hint: "goal" } },
        { name: "broken" },
      ]),
    }),
    withCommands(uniqueWorkspace()),
  );
  assertEquals(discovery.commands, [
    { name: "review", description: "Review the diff" },
    { name: "plan", description: "Plan a change", inputHint: "goal" },
  ]);
  assertEquals(discovery.models.length, 3);
});

Deno.test("a report that arrives before session/new answers counts", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], {
      before: commandReport([{ name: "review", description: "Review" }]),
    }),
    withCommands(uniqueWorkspace()),
  );
  assertEquals(discovery.commands, [{ name: "review", description: "Review" }]);
});

Deno.test("an agent that reports no commands is told apart from one that reports none", async () => {
  const empty = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], { after: commandReport([]) }),
    withCommands(uniqueWorkspace()),
  );
  assertEquals(empty.commands, []);

  // Nothing arrives: the wait ends where the cleanup reserve begins, and commands stay unknown.
  const started = Date.now();
  const silent = await discoverClaude(
    fakeProcesses(defaultAcpAgent),
    withCommands(uniqueWorkspace(), {
      deadline: Date.now() + AGENT_DISCOVERY_CLEANUP_RESERVE_MS + 100,
    }),
  );
  assertEquals("commands" in silent, false);
  assertEquals(silent.models.length, 3);
  assertEquals(Date.now() - started < 2_000, true);
});

Deno.test("a models-only discovery neither waits for nor returns commands", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], {
      after: commandReport([{ name: "review", description: "Review" }]),
    }),
    modelsOnly(uniqueWorkspace()),
  );
  assertEquals("commands" in discovery, false);
});

Deno.test("the probe session gets the session's Skills and no MCP servers", async () => {
  const requests: Record<string, JsonValue>[] = [];
  const skills: AgentDiscoverSkills = {
    readRoots: ["/skills/root"],
    directories: ["/skills/root/review"],
    revision: "7",
  };
  const answer =
    (declared: boolean) => (request: Record<string, JsonValue>): JsonValue => {
      requests.push(request);
      if (request.method === "initialize") {
        return {
          protocolVersion: 1,
          agentCapabilities: declared
            ? { sessionCapabilities: { additionalDirectories: {} } }
            : {},
        };
      }
      return defaultAcpAgent(request);
    };
  const sessionNew = () =>
    requests.findLast((request) => request.method === "session/new")
      ?.params as Record<string, JsonValue>;

  const cwd = uniqueWorkspace();
  await discoverClaude(
    fakeProcesses(answer(true), [], { after: commandReport([]) }),
    withCommands(cwd, { skills }),
  );
  assertEquals(sessionNew(), {
    cwd,
    mcpServers: [],
    additionalDirectories: ["/skills/root"],
    _meta: { "ora/skillDirectories": ["/skills/root/review"] },
  });

  // An agent that does not declare additionalDirectories is not sent them.
  await discoverClaude(
    fakeProcesses(answer(false), [], { after: commandReport([]) }),
    withCommands(uniqueWorkspace(), { skills }),
  );
  assertEquals("additionalDirectories" in sessionNew(), false);
});

Deno.test("an answer is reused only for the same input, Skills revision included", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns, {
    after: commandReport([]),
  });
  const cwd = uniqueWorkspace();
  const skills = (revision: string): AgentDiscoverSkills => ({
    readRoots: [],
    directories: ["/skills/review"],
    revision,
  });
  await Promise.all([
    discoverClaude(processes, withCommands(cwd, { skills: skills("1") })),
    discoverClaude(processes, withCommands(cwd, { skills: skills("1") })),
  ]);
  assertEquals(spawns.length, 1, "the same input");
  await discoverClaude(processes, withCommands(cwd, { skills: skills("2") }));
  assertEquals(spawns.length, 2, "another revision");
  await discoverClaude(processes, modelsOnly(cwd));
  assertEquals(spawns.length, 3, "a models-only question");
});

let workspaces = 0;

/** A workspace no other test has asked about, so no cached answer is shared between tests. */
function uniqueWorkspace(): string {
  workspaces += 1;
  return `/workspace-${workspaces}`;
}

/** A discovery that wants only models, as `agent/list_models` asks. */
function modelsOnly(cwd: string): AgentDiscoveryContext {
  return { cwd, includeCommands: false, deadline: Date.now() + 30_000 };
}

/** A discovery that wants commands too, as a chat surface asks. */
function withCommands(
  cwd: string,
  overrides: Partial<AgentDiscoveryContext> = {},
): AgentDiscoveryContext {
  return {
    cwd,
    includeCommands: true,
    deadline: Date.now() + 30_000,
    ...overrides,
  };
}

/** The ACP notification listing a probe session's commands. */
function commandReport(availableCommands: JsonValue[]): JsonValue {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "probe-session",
      update: { sessionUpdate: "available_commands_update", availableCommands },
    },
  };
}

/** Answers one ACP request the way `claude-agent-acp` with a model selector would. */
function defaultAcpAgent(request: Record<string, JsonValue>): JsonValue {
  if (request.method === "initialize") {
    // No `sessionCapabilities.delete`, like an adapter that cannot remove a session.
    return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
  }
  if (request.method === "session/new") {
    return {
      sessionId: "probe-session",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "deep",
          options: [
            { value: "fast", name: "Fast" },
            { value: "deep", name: "Deep" },
            {
              group: "extra",
              name: "Extra",
              options: [{ value: "grouped", name: "Grouped" }],
            },
          ],
        },
      ],
    };
  }
  throw new Error(`unexpected ACP method ${String(request.method)}`);
}

/**
 * Builds a `HostProcesses` whose children speak ACP from `respond`, recording every spawn, and
 * emit `notifications` around the answer to `session/new`.
 */
function fakeProcesses(
  respond: (request: Record<string, JsonValue>) => JsonValue,
  spawns: HostChildProcessOptions[] = [],
  notifications: { before?: JsonValue; after?: JsonValue } = {},
): HostProcesses {
  return {
    spawn(options) {
      spawns.push(options);
      let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended: (() => void) | undefined;
      const child: HostChildProcess = {
        pid: 1234,
        stdout: new ReadableStream({
          start: (controller) => {
            stdout = controller;
          },
        }),
        stderr: new ReadableStream({
          start: (controller) => controller.close(),
        }),
        exited: new Promise((resolve) => {
          ended = () => resolve({ code: 0, signal: null });
        }),
        write: (bytes) => {
          for (const line of new TextDecoder().decode(bytes).split("\n")) {
            if (line.trim() === "") continue;
            const request = JSON.parse(line) as Record<string, JsonValue>;
            const emit = (frame: JsonValue) =>
              stdout?.enqueue(
                new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
              );
            const opensSession = request.method === "session/new";
            if (opensSession && notifications.before !== undefined) {
              emit(notifications.before);
            }
            emit({ jsonrpc: "2.0", id: request.id, result: respond(request) });
            if (opensSession && notifications.after !== undefined) {
              emit(notifications.after);
            }
          }
          return Promise.resolve();
        },
        closeStdin: () => Promise.resolve(),
        kill: () => {
          stdout?.close();
          ended?.();
          return Promise.resolve();
        },
      };
      return Promise.resolve(child);
    },
  };
}
