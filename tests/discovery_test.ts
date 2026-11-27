import { assertEquals, assertRejects } from "@std/assert";
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
import {
  discoverClaude,
  invalidateClaudeDiscovery,
} from "../src/handlers/discovery.ts";

/** A request the scripted adapter never answers. */
const NO_ANSWER = Symbol("no answer");

/** What a scripted adapter answers besides a result: nothing, or an error. */
type Scripted = typeof NO_ANSWER | { error: JsonValue };

/**
 * The session capabilities `claude-agent-acp` 0.113.0 declares in `initialize` that discovery
 * reads (`dist/v1/acp-agent.js`); the rest of its answer is left out.
 */
const CLAUDE_ACP_INITIALIZE = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: {
      additionalDirectories: {},
      close: {},
      delete: {},
      fork: {},
      list: {},
      resume: {},
    },
  },
};

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

Deno.test("only the probe session's own report counts", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], {
      before: commandReport(
        [{ name: "elsewhere", description: "Another session" }],
        "other-session",
      ),
      after: commandReport([{ name: "review", description: "Review" }]),
    }),
    withCommands(uniqueWorkspace()),
  );
  assertEquals(discovery.commands, [{ name: "review", description: "Review" }]);
});

Deno.test("an answer that names no session has no report to wait for", async () => {
  const started = Date.now();
  const discovery = await discoverClaude(
    fakeProcesses(
      (request) =>
        request.method === "session/new"
          ? withoutSessionId(defaultAcpAgent(request))
          : defaultAcpAgent(request),
      [],
      { after: commandReport([{ name: "review", description: "Review" }]) },
    ),
    withCommands(uniqueWorkspace()),
  );
  assertEquals("commands" in discovery, false);
  assertEquals(Date.now() - started < 1_000, true);
});

Deno.test("the wait lasts for a report that comes a little after the answer", async () => {
  const discovery = await discoverClaude(
    fakeProcesses(defaultAcpAgent, [], {
      after: commandReport([{ name: "review", description: "Review" }]),
      afterDelayMs: 50,
    }),
    withCommands(uniqueWorkspace()),
  );
  assertEquals(discovery.commands, [{ name: "review", description: "Review" }]);
});

for (
  const [outcome, deleted] of [
    ["answers", {}],
    ["fails", { error: { code: -32603, message: "cannot delete" } }],
    ["never answers", NO_ANSWER],
  ] as [string, JsonValue | Scripted][]
) {
  Deno.test(`the adapter's probe session is deleted; when the delete ${outcome} the answer is still in time and the process ended once`, async () => {
    const requests: Record<string, JsonValue>[] = [];
    const kills = { count: 0 };
    // Room for the handshake once the cleanup reserve is set aside, and no more.
    const deadline = Date.now() + AGENT_DISCOVERY_CLEANUP_RESERVE_MS + 1_000;
    const discovery = await discoverClaude(
      fakeProcesses(
        (request) => {
          requests.push(request);
          if (request.method === "initialize") {
            return CLAUDE_ACP_INITIALIZE;
          }
          if (request.method === "session/delete") {
            return deleted;
          }
          return defaultAcpAgent(request);
        },
        [],
        {
          after: commandReport([{ name: "review", description: "Review" }]),
          kills,
        },
      ),
      withCommands(uniqueWorkspace(), { deadline }),
    );
    // Ora still gets everything already read, before its deadline.
    assertEquals(Date.now() < deadline, true);
    assertEquals(discovery.models.length, 3);
    assertEquals(discovery.commands, [{
      name: "review",
      description: "Review",
    }]);
    assertEquals(requests.map((request) => request.method), [
      "initialize",
      "session/new",
      "session/delete",
    ]);
    assertEquals(requests[2].params, { sessionId: "probe-session" });
    assertEquals(kills.count, 1);
  });
}

Deno.test("a failed discovery is not reused, while unknown commands are", async () => {
  const spawns: HostChildProcessOptions[] = [];
  let failing = true;
  const processes = fakeProcesses((request): JsonValue | Scripted => {
    if (request.method === "session/new" && failing) {
      return { error: { code: -32603, message: "not ready" } };
    }
    return defaultAcpAgent(request);
  }, spawns);
  const cwd = uniqueWorkspace();
  const quick = () =>
    withCommands(cwd, {
      deadline: Date.now() + AGENT_DISCOVERY_CLEANUP_RESERVE_MS + 100,
    });
  await assertRejects(() => discoverClaude(processes, quick()));
  failing = false;
  const unknown = await discoverClaude(processes, quick());
  assertEquals("commands" in unknown, false);
  assertEquals(spawns.length, 2, "the failure was asked again");
  assertEquals(await discoverClaude(processes, quick()), unknown);
  assertEquals(spawns.length, 2, "unknown commands are an answer");
});

Deno.test("every part of the Skill input is in the cache key", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns, {
    after: commandReport([]),
  });
  const cwd = uniqueWorkspace();
  const ask = (skills: AgentDiscoverSkills) =>
    discoverClaude(processes, withCommands(cwd, { skills }));
  const base = { readRoots: ["/a"], directories: ["/a/review"], revision: "1" };
  await ask(base);
  await ask({ ...base, readRoots: ["/b"] });
  await ask({ ...base, directories: ["/a/audit"] });
  assertEquals(spawns.length, 3);
  await discoverClaude(processes, modelsOnly(cwd));
  await discoverClaude(processes, modelsOnly(cwd));
  assertEquals(spawns.length, 4, "models-only has a key of its own");
});

Deno.test("an answer expires after five minutes", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns);
  const cwd = uniqueWorkspace();
  await discoverClaude(processes, modelsOnly(cwd));
  const now = Date.now;
  Date.now = () => now() + 4 * 60_000;
  try {
    await discoverClaude(processes, modelsOnly(cwd));
    assertEquals(spawns.length, 1, "still fresh");
    Date.now = () => now() + 6 * 60_000;
    await discoverClaude(processes, modelsOnly(cwd));
    assertEquals(spawns.length, 2, "expired");
  } finally {
    Date.now = now;
  }
});

Deno.test("starting or stopping the agent drops its workspace's answers", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns, {
    after: commandReport([]),
  });
  const [cwd, other] = [uniqueWorkspace(), uniqueWorkspace()];
  for (
    const context of [modelsOnly(cwd), withCommands(cwd), modelsOnly(other)]
  ) {
    await discoverClaude(processes, context);
  }
  invalidateClaudeDiscovery(cwd);
  for (
    const context of [modelsOnly(cwd), withCommands(cwd), modelsOnly(other)]
  ) {
    await discoverClaude(processes, context);
  }
  assertEquals(
    spawns.length,
    5,
    "both answers for the workspace, not the other one",
  );
  // The entrypoint does this on agent/start and agent/stop; read as text, since importing it
  // would start serving the host.
  const entrypoint = await Deno.readTextFile(
    new URL("../src/main.ts", import.meta.url),
  );
  for (const hook of ["override onStart", "override onStop"]) {
    const body = entrypoint.slice(entrypoint.indexOf(hook));
    assertEquals(
      body.slice(0, body.indexOf("};")).includes(
        "invalidateClaudeDiscovery(",
      ),
      true,
      hook,
    );
  }
});

/** A `session/new` answer without the id of the session it opened. */
function withoutSessionId(answer: JsonValue): JsonValue {
  const { sessionId: _, ...rest } = answer as Record<string, JsonValue>;
  return rest;
}
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
function commandReport(
  availableCommands: JsonValue[],
  sessionId = "probe-session",
): JsonValue {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands },
    },
  };
}

/** Answers one ACP request the way `claude-agent-acp` with a model selector would. */
function defaultAcpAgent(request: Record<string, JsonValue>): JsonValue {
  if (request.method === "initialize") {
    // A minimal adapter: no `sessionCapabilities`, so no delete and no `additionalDirectories`.
    // `claude-agent-acp` itself declares both; see `CLAUDE_ACP_INITIALIZE`.
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
  respond: (request: Record<string, JsonValue>) => JsonValue | Scripted,
  spawns: HostChildProcessOptions[] = [],
  notifications: {
    before?: JsonValue;
    after?: JsonValue;
    /** How long after the `session/new` answer `after` is sent. */
    afterDelayMs?: number;
    /** Counts the probe processes ended. */
    kills?: { count: number };
  } = {},
): HostProcesses {
  return {
    spawn(options) {
      spawns.push(options);
      let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
      let ended: (() => void) | undefined;
      let open = true;
      const emit = (frame: JsonValue) => {
        if (open) {
          stdout?.enqueue(
            new TextEncoder().encode(`${JSON.stringify(frame)}\n`),
          );
        }
      };
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
            const opensSession = request.method === "session/new";
            if (opensSession && notifications.before !== undefined) {
              emit(notifications.before);
            }
            const answer = respond(request);
            if (answer === NO_ANSWER) {
              continue;
            }
            emit(
              isScriptedError(answer)
                ? { jsonrpc: "2.0", id: request.id, error: answer.error }
                : {
                  jsonrpc: "2.0",
                  id: request.id,
                  result: answer as JsonValue,
                },
            );
            const after = notifications.after;
            if (opensSession && after !== undefined) {
              if (notifications.afterDelayMs === undefined) {
                emit(after);
              } else {
                setTimeout(() => emit(after), notifications.afterDelayMs);
              }
            }
          }
          return Promise.resolve();
        },
        closeStdin: () => Promise.resolve(),
        kill: () => {
          if (open) {
            open = false;
            if (notifications.kills !== undefined) {
              notifications.kills.count += 1;
            }
            stdout?.close();
            ended?.();
          }
          return Promise.resolve();
        },
      };
      return Promise.resolve(child);
    },
  };
}

function isScriptedError(answer: unknown): answer is { error: JsonValue } {
  return typeof answer === "object" && answer !== null &&
    !Array.isArray(answer) && "error" in answer &&
    Object.keys(answer).length === 1;
}
