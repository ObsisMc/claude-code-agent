/**
 * Drives the plugin exactly the way Ora's host does, against a real Claude Code ACP adapter.
 *
 * Run it with the same permissions Ora grants an agent plugin:
 *   deno task simulate
 */
import type { JsonValue } from "@ora-space/plugin-sdk";

const JSON_RPC_FRAME_TYPE = 0x01;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/**
 * Encodes and decodes Ora's binary JSON-RPC frame envelope.
 *
 * This is a standalone reimplementation of the wire format, not an import from the plugin SDK:
 * this file plays the host's side of the protocol, and the host does not depend on the SDK it is
 * exercising.
 */

/** Encodes one JSON value into Ora's binary JSON-RPC frame envelope. */
function encodeFrame(message: JsonValue): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const length = payload.byteLength + 1;
  if (length > MAX_FRAME_LENGTH) {
    throw new Error(`Plugin frame exceeds ${MAX_FRAME_LENGTH} bytes`);
  }

  const frame = new Uint8Array(length + 4);
  new DataView(frame.buffer).setUint32(0, length, false);
  frame[4] = JSON_RPC_FRAME_TYPE;
  frame.set(payload, 5);
  return frame;
}

/** Decodes arbitrarily fragmented bytes into complete JSON-RPC messages. */
async function* decodeFrames(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  let buffer = new Uint8Array();
  for await (const chunk of readable) {
    const combined = new Uint8Array(buffer.byteLength + chunk.byteLength);
    combined.set(buffer);
    combined.set(chunk, buffer.byteLength);
    buffer = combined;

    while (buffer.byteLength >= 4) {
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).getUint32(0, false);
      if (length < 1 || length > MAX_FRAME_LENGTH) {
        throw new Error(`Invalid plugin frame length ${length}`);
      }
      if (buffer.byteLength < length + 4) {
        break;
      }
      if (buffer[4] !== JSON_RPC_FRAME_TYPE) {
        throw new Error(`Unsupported plugin frame type ${buffer[4]}`);
      }

      const payload = buffer.slice(5, length + 4);
      buffer = buffer.slice(length + 4);
      yield JSON.parse(new TextDecoder().decode(payload));
    }
  }

  if (buffer.byteLength !== 0) {
    throw new Error("Plugin protocol stream ended inside a frame");
  }
}

// Exactly what Ora grants an agent plugin (see `permissions::agent_permissions`), not what this
// plugin turns out to need: no process here is spawned by the plugin any more — both the ACP
// adapter and the discovery probe go through `ora/childprocess/*` below, which this simulator
// serves — and running with a narrower set than production would hide a permission fault instead
// of reproducing it.
const HOST_PERMISSIONS = [
  "--no-prompt",
  "--allow-run",
  "--allow-read",
  "--allow-env",
  "--allow-net",
];

/** Converts one module-relative URL into a host path, including a Windows drive prefix. */
function modulePath(relative: string): string {
  return decodeURIComponent(new URL(relative, import.meta.url).pathname)
    .replace(/^\/([A-Za-z]:)/, "$1");
}

const entrypoint = modulePath("../src/main.ts");
const child = new Deno.Command(Deno.execPath(), {
  args: ["run", ...HOST_PERMISSIONS, entrypoint],
  stdin: "piped",
  stdout: "piped",
  stderr: "inherit",
}).spawn();

const writer = child.stdin.getWriter();
const send = (message: JsonValue) => writer.write(encodeFrame(message));
const inbound = decodeFrames(child.stdout)[Symbol.asyncIterator]();

/** Reads frames until one satisfies `match`, so streamed notifications never desynchronize. */
async function waitFor(
  match: (message: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  while (true) {
    const next = await inbound.next();
    if (next.done) {
      throw new Error(`plugin closed stdout while waiting for ${label}`);
    }
    const message = next.value as Record<string, unknown>;
    if (isChildProcessRequest(message)) {
      // The plugin no longer spawns `claude-agent-acp` itself; it asks this simulator, playing the
      // host, to do it. Answered off the main wait loop's critical path so a slow spawn cannot
      // desync reading of unrelated frames arriving concurrently.
      void handleChildProcessRequest(message).catch((error) => {
        console.error(`[host] ora/childprocess request failed: ${error}`);
      });
      continue;
    }
    if (match(message)) {
      return message;
    }
    console.log(`[host] << ${JSON.stringify(message).slice(0, 160)}`);
  }
}

/** One subprocess this simulator, playing the host, spawned on the plugin's behalf. */
interface SimulatedChildProcess {
  child: Deno.ChildProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

const simulatedChildProcesses = new Map<string, SimulatedChildProcess>();
let nextChildProcessId = 1;

/** Recognizes a plugin-to-host request for `ora/childprocess/*`. */
function isChildProcessRequest(
  message: Record<string, unknown>,
): message is Record<string, unknown> & {
  id: number | string;
  method: string;
} {
  return typeof message.method === "string" &&
    message.method.startsWith("ora/childprocess/") &&
    (typeof message.id === "number" || typeof message.id === "string");
}

/**
 * Serves one `ora/childprocess/*` request the same way Ora's real host does: this simulator owns
 * the real `claude-agent-acp` process and relays its stdout/stderr/exit back as notifications.
 */
async function handleChildProcessRequest(
  message: Record<string, unknown> & { id: number | string; method: string },
): Promise<void> {
  try {
    const result = await dispatchChildProcessMethod(
      message.method,
      (message.params ?? {}) as Record<string, unknown>,
    );
    await send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    // Ora classifies every childprocess failure with a stable `data.kind`, and the plugin branches
    // on it, so a simulator that answered with a bare message would exercise a path production
    // never takes.
    const classified = error instanceof SimulatedSpawnError
      ? error
      : new SimulatedSpawnError(
        "io",
        error instanceof Error ? error.message : String(error),
      );
    await send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: classified.kind === "io" ? -32000 : -32602,
        message: classified.message,
        data: { kind: classified.kind },
      },
    });
  }
}

/** One childprocess failure carrying the classification Ora's host would have attached. */
class SimulatedSpawnError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function dispatchChildProcessMethod(
  method: string,
  params: Record<string, unknown>,
): Promise<JsonValue> {
  switch (method) {
    case "ora/childprocess/spawn": {
      // This package ships no adapter of its own, so the plugin never names a `packageCommand`.
      // Answering as Ora would for a package that carries nothing keeps the PATH fallback the
      // only path exercised.
      if (params.packageCommand !== undefined) {
        throw new SimulatedSpawnError(
          "package_command_missing",
          "this package bundles no executable",
        );
      }
      const command = params.command as string;
      const args = (params.args as string[] | undefined) ?? [];
      const cwd = (params.cwd as string | null | undefined) ?? undefined;
      let child: Deno.ChildProcess;
      try {
        child = new Deno.Command(command, {
          args,
          cwd,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
      } catch (error) {
        throw new SimulatedSpawnError(
          error instanceof Deno.errors.NotFound ? "program_not_found" : "io",
          error instanceof Error ? error.message : String(error),
        );
      }
      const processId = String(nextChildProcessId++);
      simulatedChildProcesses.set(processId, {
        child,
        stdinWriter: child.stdin.getWriter(),
      });
      void pumpChildOutput(processId, child.stdout, "ora/childprocess/stdout");
      void pumpChildOutput(processId, child.stderr, "ora/childprocess/stderr");
      void child.status.then(async (status) => {
        simulatedChildProcesses.delete(processId);
        await notifyHostBestEffort({
          jsonrpc: "2.0",
          method: "ora/childprocess/exit",
          params: { processId, code: status.code, signal: null },
        });
      });
      return { processId, pid: child.pid };
    }
    case "ora/childprocess/write": {
      const process = requireSimulatedProcess(params);
      await process.stdinWriter.write(
        base64Decode(params.bytesBase64 as string),
      );
      return {};
    }
    case "ora/childprocess/close_stdin": {
      await requireSimulatedProcess(params).stdinWriter.close();
      return {};
    }
    case "ora/childprocess/kill": {
      requireSimulatedProcess(params).child.kill();
      return {};
    }
    default:
      throw new Error(`unsupported host method ${method}`);
  }
}

function requireSimulatedProcess(
  params: Record<string, unknown>,
): SimulatedChildProcess {
  const processId = params.processId as string;
  const process = simulatedChildProcesses.get(processId);
  if (process === undefined) {
    throw new Error(`unknown processId ${processId}`);
  }
  return process;
}

/** Streams one piped stdio stream as base64-encoded `ora/childprocess/{stdout,stderr}` chunks. */
async function pumpChildOutput(
  processId: string,
  stream: ReadableStream<Uint8Array>,
  method: string,
): Promise<void> {
  for await (const chunk of stream) {
    await notifyHostBestEffort({
      jsonrpc: "2.0",
      method,
      params: { processId, bytesBase64: base64Encode(chunk) },
    });
  }
}

/**
 * Sends one notification, swallowing failure exactly as the real host does: `agent/stop` does
 * not wait for a killed process to finish exiting, so a trailing chunk or the eventual exit
 * notification can still be in flight after the plugin connection has already closed.
 */
async function notifyHostBestEffort(message: JsonValue): Promise<void> {
  try {
    await send(message);
  } catch {
    // The plugin connection is already gone; there is nothing left to notify.
  }
}

/** Encodes bytes as standard base64 without building one giant intermediate string. */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Decodes standard base64 into bytes. */
function base64Decode(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Fails the simulation loudly and narrows values for the checks that follow. */
function check(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(`check failed: ${label}`);
  }
}

const acpFrame = (message: Record<string, unknown>): Record<string, unknown> =>
  (message.params ?? {}) as Record<string, unknown>;

const register = await waitFor(
  (message) => message.method === "ora/register",
  "ora/register",
);
const registration = register.params as { methods: string[]; emits: string[] };
for (
  const method of [
    "agent/start",
    "agent/stop",
    "agent/discover",
    "agent/list_models",
  ]
) {
  check(registration.methods.includes(method), `registers ${method}`);
}
check(registration.emits.includes("agent/acp"), "emits agent/acp");
console.log(`ok: register ${JSON.stringify(register.params)}`);

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "agent/start",
  params: { cwd: Deno.cwd(), hostVersion: "0.8.0" },
});
const started = await waitFor((message) => message.id === 1, "agent/start");
check(
  JSON.stringify(started.result) === JSON.stringify({
    protocol: "acp",
    acpVersion: 1,
  }),
  "agent/start returns the ACP protocol descriptor",
);
console.log(
  `ok: agent/start ${JSON.stringify(started.result ?? started.error)}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    },
  },
});
const initialized = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 1,
  "ACP initialize",
);
const initializeResult = acpFrame(initialized).result as {
  protocolVersion?: number;
  agentInfo?: { name?: string };
};
check(initializeResult?.protocolVersion === 1, "ACP protocol version is 1");
console.log(
  `ok: initialize ${initializeResult?.agentInfo?.name} protocolVersion ${initializeResult?.protocolVersion}`,
);

await send({
  jsonrpc: "2.0",
  method: "agent/acp",
  params: {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: Deno.cwd(), mcpServers: [] },
  },
});
const session = await waitFor(
  (message) => message.method === "agent/acp" && acpFrame(message).id === 2,
  "ACP session/new",
);
const sessionResult = acpFrame(session).result as {
  sessionId?: string;
  configOptions?: { id: string; category?: string; options?: unknown[] }[];
} | undefined;
check(
  typeof sessionResult?.sessionId === "string",
  "session/new returns an id",
);
const modelOption = sessionResult?.configOptions?.find(
  (option) => option.category === "model",
);
check(modelOption !== undefined, "session/new carries a model config option");
check(
  Array.isArray(modelOption.options) && modelOption.options.length > 0,
  "the ACP model config option contains choices",
);
console.log(
  `ok: session/new ${sessionResult.sessionId} models via ACP: ${
    JSON.stringify(
      modelOption.options?.map((option) =>
        (option as { value?: unknown }).value
      ),
    )
  }`,
);

// Discovery names the Workspace it is answering for, and the plugin answers it by running a
// second, one-shot `claude-agent-acp` through this simulator rather than by borrowing the
// connection opened above — so this step also proves the live bridge survives a probe running
// beside it. It asks for commands too, the way a chat surface does, with no Skills.
await send({
  jsonrpc: "2.0",
  id: 2,
  method: "agent/discover",
  params: {
    cwd: Deno.cwd(),
    includeCommands: true,
    deadline: Date.now() + 60_000,
    skills: { readRoots: [], directories: [], revision: "0" },
  },
});
const discovered = await waitFor(
  (message) => message.id === 2,
  "agent/discover",
);
check(
  discovered.error === undefined,
  `agent/discover answered without an error (${
    JSON.stringify(discovered.error)
  })`,
);
const discovery = (discovered.result ?? {}) as {
  models?: unknown[];
  commands?: unknown[];
};
const modelList = discovery.models;
check(Array.isArray(modelList), "agent/discover returns a model array");
// The pre-session list and the in-session picker read one source, so discovery must reproduce the
// choices the ACP session above already advertised.
check(
  modelList.length === (modelOption.options?.length ?? 0),
  "discovery reports the same models as the ACP session config option",
);
// Absent commands mean the adapter sent no report in time; an empty list means it said it has none.
console.log(
  `ok: discover ${modelList.length} models via a probe session, first ${
    JSON.stringify(modelList[0])
  }; commands ${
    discovery.commands === undefined
      ? "unknown (no report in time)"
      : JSON.stringify(
        discovery.commands.map((command) =>
          (command as { name?: unknown }).name
        ),
      )
  }`,
);

await send({ jsonrpc: "2.0", id: 3, method: "agent/stop", params: {} });
await waitFor((message) => message.id === 3, "agent/stop");
console.log("ok: agent/stop");

await send({ jsonrpc: "2.0", method: "ora/shutdown" });
await writer.close();
const status = await child.status;
console.log(`plugin exited with code ${status.code}`);
console.log(
  status.success
    ? "ALL HOST SIMULATION CHECKS PASSED"
    : "PLUGIN EXITED NON-ZERO",
);
Deno.exit(status.success ? 0 : 1);
