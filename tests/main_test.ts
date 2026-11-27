import { assertEquals, assertRejects } from "@std/assert";
import type {
  HostChildProcess,
  HostChildProcessOptions,
  HostProcesses,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { AGENT_NOT_INSTALLED, HostRequestError } from "@ora-space/plugin-sdk";
import { forwardAcpFrame } from "../src/handlers/acp.ts";
import { discoverClaude } from "../src/handlers/discovery.ts";
import { BIN_ENV_VAR, resolveClaudeCommands } from "../src/services/command.ts";
import {
  bundledAdapterPath,
  bundledClaudePath,
} from "../src/services/bundled-binary.ts";
import {
  declarationAssociation,
  packagedDeclaration,
  releaseManifest,
} from "../scripts/package.ts";
import { BlobReader, ZipWriter } from "@zip-js/zip-js";
import {
  ClaudeClient,
  type SpawnedProcess,
} from "../src/services/claude-client.ts";
import { decodeLines } from "../src/services/ndjson.ts";

/** Discovers models only, as `agent/list_models` asks, and answers just them. */
function listModels(processes: HostProcesses, cwd: string) {
  return discoverClaude(processes, {
    cwd,
    includeCommands: false,
    deadline: Date.now() + 30_000,
  }).then(({ models }) => models);
}

Deno.test("ora-space.claude declares an agent kind", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../orax.toml", import.meta.url),
  );
  assertEquals(manifest.includes('kind = "agent"'), true);
});

Deno.test("every Windows spelling an installer writes is named", () => {
  assertEquals(
    resolveClaudeCommands(),
    Deno.build.os === "windows"
      ? [
        "claude-agent-acp.exe",
        "claude-agent-acp.cmd",
        "claude-agent-acp.bat",
        "claude-agent-acp",
      ]
      : ["claude-agent-acp"],
  );
});

Deno.test("the release manifest is what a marketplace entry is pasted from", () => {
  const rendered = releaseManifest(
    [
      "resolver = 1",
      'identifier = "ora-space.claude"',
      'version = "0.3.0"',
      "",
    ].join("\n"),
    [
      {
        triple: "x86_64-pc-windows-msvc",
        url: "https://example.invalid/a.orax",
        sha256: "aa",
      },
      {
        triple: "aarch64-apple-darwin",
        url: "https://example.invalid/b.orax",
        sha256: "bb",
      },
    ],
  );
  assertEquals(
    rendered,
    `resolver = 1
identifier = "ora-space.claude"
version = "0.3.0"

[[targets]]
target = "x86_64-pc-windows-msvc"
url = "https://example.invalid/a.orax"
sha256 = "aa"

[[targets]]
target = "aarch64-apple-darwin"
url = "https://example.invalid/b.orax"
sha256 = "bb"
`,
  );
  // The host rejects a manifest carrying both release forms, and it reads the top-level keys as
  // the plugin's own only while they precede every table header.
  assertEquals(
    /^url =|^sha256 =/m.test(rendered.split("[[targets]]")[0]),
    false,
  );
  assertEquals(rendered.includes("[artifact]"), false);
});

Deno.test("the shipped declaration is the pinned personal-model shape", async () => {
  const bytes = await Deno.readFile(
    new URL("../assets/config.json", import.meta.url),
  );
  const association = await declarationAssociation(bytes);
  assertEquals(association.schemaVersion, 2);
  // The digest is the declaration's published identity, byte-pinned against the shared
  // cross-language contract samples: reformatting the file is a release-affecting change that
  // this test exists to force someone to notice, not something formatting can do silently.
  assertEquals(
    association.declarationSha256,
    "2d1afa5e03b476385a6c188f7444184be11e82e81191d8efe2e9f354456753c1",
  );
  assertEquals(association.copy, "agent-configuration.json");
});

Deno.test("packagedDeclaration reads bound bytes back, and reports their absence", async () => {
  // The read-back is what makes the release association derived from the archive's own bytes;
  // its absence is a valid state, because a release built without `--agent-configuration`
  // ships no declaration at all — current Ora hosts install such a package as before, while
  // one carrying the declaration would install and then refuse to activate.
  const encode = (text: string) => new TextEncoder().encode(text);
  const declaration = encode('{"schemaVersion":2}');
  const writePackage = async (
    entries: [string, Uint8Array<ArrayBuffer>][],
  ) => {
    const path = await Deno.makeTempFile();
    const file = await Deno.open(path, { write: true, truncate: true });
    const writer = new ZipWriter(file.writable);
    for (const [name, bytes] of entries) {
      await writer.add(name, new BlobReader(new Blob([bytes])));
    }
    await writer.close();
    return path;
  };

  const bound = await writePackage([
    ["orax.toml", encode("resolver = 1")],
    ["assets/config.json", declaration],
  ]);
  try {
    assertEquals(await packagedDeclaration(bound), declaration);
  } finally {
    await Deno.remove(bound);
  }

  const unbound = await writePackage([
    ["orax.toml", encode("resolver = 1")],
  ]);
  try {
    assertEquals(await packagedDeclaration(unbound), undefined);
  } finally {
    await Deno.remove(unbound);
  }
});

Deno.test("a declaration no host compiler would accept cannot be bound", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  // The packaging script does not re-implement the declaration schema; these are the checks it
  // owns — readable UTF-8, a positive integer schemaVersion, and the size bound every host
  // enforces — and anything beyond them is left to the host compilers at sync and install.
  await assertRejects(
    () => declarationAssociation(encode("not json at all")),
    Error,
  );
  await assertRejects(
    () => declarationAssociation(encode('{"agent":{}}')),
    Error,
  );
  await assertRejects(
    () => declarationAssociation(encode('{"schemaVersion":0}')),
    Error,
  );
  await assertRejects(
    () => declarationAssociation(new Uint8Array(256 * 1024 + 1)),
    Error,
  );
});

Deno.test("the release manifest binds the declaration before its targets", () => {
  const rendered = releaseManifest(
    [
      "resolver = 1",
      'identifier = "ora-space.claude"',
      'version = "0.3.0"',
    ].join("\n"),
    [
      {
        triple: "x86_64-pc-windows-msvc",
        url: "https://example.invalid/a.orax",
        sha256: "aa",
      },
    ],
    {
      schemaVersion: 2,
      declarationSha256:
        "2d1afa5e03b476385a6c188f7444184be11e82e81191d8efe2e9f354456753c1",
      copy: "agent-configuration.json",
    },
  );
  assertEquals(
    rendered,
    `resolver = 1
identifier = "ora-space.claude"
version = "0.3.0"

[agent_configuration]
schema_version = 2
declaration_sha256 = "2d1afa5e03b476385a6c188f7444184be11e82e81191d8efe2e9f354456753c1"
copy = "agent-configuration.json"

[[targets]]
target = "x86_64-pc-windows-msvc"
url = "https://example.invalid/a.orax"
sha256 = "aa"
`,
  );
});

Deno.test("both bundled binaries land where each consumer looks for them", () => {
  // These four strings are a contract between three files that never call each other: the plugin
  // asks the host to spawn the adapter at one, the compiled adapter looks beside itself for the
  // CLI at the other, and packaging stages both. Asserting the literals is the point — a change
  // that "just renames a path" has to be made in every one of them or the package cannot start.
  assertEquals(
    bundledAdapterPath("windows"),
    "assets/bin/claude-agent-acp.exe",
  );
  assertEquals(bundledAdapterPath("linux"), "assets/bin/claude-agent-acp");
  assertEquals(bundledClaudePath("windows"), "assets/bin/claude.exe");
  assertEquals(bundledClaudePath("darwin"), "assets/bin/claude");
});

Deno.test("the bundled adapter is asked for before anything on PATH", async () => {
  const spawns: HostChildProcessOptions[] = [];
  await listModels(
    fakeProcesses(defaultAcpAgent, spawns),
    uniqueWorkspace(),
  );
  // Ora only reaches into a package for a binary the plugin names, so omitting this is the whole
  // difference between a package that runs what it ships and one that silently runs the user's
  // own install — which is invisible until the two versions disagree.
  assertEquals(
    spawns.map((options) => options.packageCommand),
    [bundledAdapterPath()],
  );
  // The ladder is sequential, not a list handed over at once: this spawn names no PATH command
  // at all, and PATH is consulted only after the host reports the package carries no such file.
  assertEquals(Object.hasOwn(spawns[0], "command"), false);
});

Deno.test("the compiled adapter never honours an inherited CLAUDE_CODE_EXECUTABLE", async () => {
  const entry = await Deno.readTextFile(
    new URL("../scripts/adapter-entry.mjs", import.meta.url),
  );
  // Read as text because importing this file starts the adapter; which CLI it resolves is tested
  // through `resolve-claude-cli.mjs` itself. `CLAUDE_CODE_EXECUTABLE` may only ever be written,
  // never read: honouring an inherited one would run a different CLI than the package ships, and
  // nothing would say so.
  assertEquals(
    entry.includes("process.env.CLAUDE_CODE_EXECUTABLE ="),
    true,
  );
  assertEquals(
    /process\.env\.CLAUDE_CODE_EXECUTABLE(?!\s*=)/.test(entry),
    false,
  );
});

Deno.test("a pinned binary is the only program spawned", async () => {
  const spawns: HostChildProcessOptions[] = [];
  await withPinnedBinary("C:\\tools\\claude-agent-acp.exe", async () => {
    await listModels(
      fakeProcesses(defaultAcpAgent, spawns),
      uniqueWorkspace(),
    );
  });
  assertEquals(spawns.map((options) => options.command), [
    "C:\\tools\\claude-agent-acp.exe",
  ]);
  // A pin names one exact executable, so nothing about the package is asked of the host either.
  assertEquals(
    spawns.every((options) => options.packageCommand === undefined),
    true,
  );
});

Deno.test("a pin that names nothing is reported as a missing adapter", async () => {
  const missing: HostProcesses = {
    spawn: () =>
      Promise.reject(
        new HostRequestError("program_not_found", "no such program"),
      ),
  };
  await withPinnedBinary("C:\\tools\\absent.exe", async () => {
    const error = await assertRejects(() =>
      listModels(missing, uniqueWorkspace())
    );
    // Ora retries this code quietly as expected local configuration rather than faulting the
    // agent, which is the whole difference between "not installed" and "broken".
    assertEquals((error as { code?: number }).code, AGENT_NOT_INSTALLED);
  });
});

Deno.test("the probe declares the capability that reveals a model selector", async () => {
  const requests: Record<string, JsonValue>[] = [];
  const kills = { count: 0 };
  await listModels(
    fakeProcesses(
      (request) => {
        requests.push(request);
        return defaultAcpAgent(request);
      },
      [],
      kills,
    ),
    uniqueWorkspace(),
  );
  const initialize = requests.find((request) =>
    request.method === "initialize"
  );
  assertEquals(
    (initialize?.params as { clientCapabilities?: JsonValue })
      ?.clientCapabilities,
    { session: { configOptions: {} } },
  );
  // An agent that serves no session/delete must not be sent one: it would fail on every probe.
  assertEquals(
    requests.some((request) => request.method === "session/delete"),
    false,
  );
  // Without a delete to send, the process is still ended.
  assertEquals(kills.count, 1);
});

Deno.test("an agent offering no selector discovers no pre-session models", async () => {
  const models = await listModels(
    fakeProcesses((request) =>
      request.method === "session/new"
        ? { sessionId: "s1", configOptions: [] }
        : defaultAcpAgent(request)
    ),
    uniqueWorkspace(),
  );
  assertEquals(models, []);
});

Deno.test("one workspace is probed once while its answer is fresh", async () => {
  const spawns: HostChildProcessOptions[] = [];
  const processes = fakeProcesses(defaultAcpAgent, spawns);
  const cwd = uniqueWorkspace();
  const [first, second] = await Promise.all([
    listModels(processes, cwd),
    listModels(processes, cwd),
  ]);
  assertEquals(first, second);
  assertEquals(spawns.length, 1);
});

Deno.test("the plugin declares no Skill Effect wiring or methods", async () => {
  const entrypoint = await Deno.readTextFile(
    new URL("../src/main.ts", import.meta.url),
  );
  assertEquals(entrypoint.includes("SkillEffectCoordinator"), false);
  assertEquals(entrypoint.includes("effects"), false);

  const base = await Deno.readTextFile(
    new URL("../src/base/agent-plugin.ts", import.meta.url),
  );
  assertEquals(base.includes("AgentEffectDefinition"), false);
  assertEquals(base.includes("plugin.effects"), false);
});

Deno.test("forwardAcpFrame pipes setup fields and prompts verbatim to the adapter", async () => {
  const { client, written } = await runningClient();
  const setup = {
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: {
      cwd: "/workspace",
      additionalDirectories: ["/data/atoms/skills", "/home/plugins/installed"],
      _meta: { "ora/skillDirectories": ["/data/atoms/skills/review"] },
    },
  };
  const load = {
    ...setup,
    id: 2,
    method: "session/load",
    params: { ...setup.params, sessionId: "existing", mcpServers: [] },
  };
  const prompt = { jsonrpc: "2.0", id: 7, method: "session/prompt" };

  await forwardAcpFrame(client, setup);
  await forwardAcpFrame(client, load);
  await forwardAcpFrame(client, prompt);
  assertEquals(written, [setup, load, prompt]);

  await client.stop();
  const afterStop = { jsonrpc: "2.0", id: 10, method: "session/prompt" };
  await forwardAcpFrame(client, afterStop);
  assertEquals(written, [setup, load, prompt]);
});

Deno.test("NDJSON reassembles frames split across chunks and CRLF", async () => {
  const chunks = ['{"a":1}\r\n{"b":', '2}\n\n{"c":3}'];
  const stream = ReadableStream.from(
    chunks.map((chunk) => new TextEncoder().encode(chunk)),
  );

  const lines: string[] = [];
  for await (const line of decodeLines(stream)) lines.push(line);

  assertEquals(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

/**
 * Returns a workspace path no other test has used.
 *
 * Discovery caches its answer per workspace for the process lifetime, so tests that shared a
 * directory would silently read each other's result instead of running their own probe.
 */
let workspaceCounter = 0;
function uniqueWorkspace(): string {
  workspaceCounter += 1;
  return `/workspace/${workspaceCounter}`;
}

/** Runs `body` with the adapter pin set, restoring whatever the environment had before. */
async function withPinnedBinary(
  value: string,
  body: () => Promise<void>,
): Promise<void> {
  const previous = Deno.env.get(BIN_ENV_VAR);
  Deno.env.set(BIN_ENV_VAR, value);
  try {
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete(BIN_ENV_VAR);
    else Deno.env.set(BIN_ENV_VAR, previous);
  }
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
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "edit",
          options: [],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
          ],
        },
      ],
    };
  }
  throw new Error(`unexpected ACP method ${String(request.method)}`);
}

/**
 * Builds a `HostProcesses` whose children speak ACP from `respond`, recording every spawn.
 *
 * The plugin no longer spawns anything itself — the host does, on its behalf — so the seam a test
 * substitutes at is the host's process client rather than `Deno.Command`. That also lets one
 * scripted adapter stand in for a machine that has none installed.
 */
function fakeProcesses(
  respond: (request: Record<string, JsonValue>) => JsonValue,
  spawns: HostChildProcessOptions[] = [],
  /** Counts the probe processes ended. */
  kills?: { count: number },
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
            const answer = JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: respond(request),
            });
            stdout?.enqueue(new TextEncoder().encode(`${answer}\n`));
          }
          return Promise.resolve();
        },
        closeStdin: () => Promise.resolve(),
        kill: () => {
          if (kills !== undefined) kills.count += 1;
          stdout?.close();
          ended?.();
          return Promise.resolve();
        },
      };
      return Promise.resolve(child);
    },
  };
}

/**
 * Starts a `ClaudeClient` over a scripted adapter, recording every frame written to it.
 */
async function runningClient(): Promise<
  { client: ClaudeClient; written: JsonValue[] }
> {
  const written: JsonValue[] = [];
  const client = new ClaudeClient({
    spawn: () => scriptedProcess(written),
  });
  await client.start("/workspace");
  return { client, written };
}

/** A `SpawnedProcess` that never speaks and only records what is written to its stdin. */
function scriptedProcess(written: JsonValue[]): SpawnedProcess {
  let ended: (() => void) | undefined;
  let stdout: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    pid: 4321,
    stdin: new WritableStream<Uint8Array>({
      write: (chunk) => {
        for (const line of new TextDecoder().decode(chunk).split("\n")) {
          if (line.trim() !== "") written.push(JSON.parse(line) as JsonValue);
        }
      },
    }),
    stdout: new ReadableStream({
      start: (controller) => {
        stdout = controller;
      },
    }),
    stderr: new ReadableStream({ start: (controller) => controller.close() }),
    exited: new Promise((resolve) => {
      ended = () => resolve();
    }),
    kill: () => {
      stdout?.close();
      ended?.();
    },
  };
}
