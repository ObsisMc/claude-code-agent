import {
  AGENT_UNUSABLE,
  type HostProcesses,
  type JsonValue,
  PluginMethodError,
} from "@ora-space/plugin-sdk";
import { spawnBundledClaude, spawnClaude } from "./command.ts";
import { logger } from "./log.ts";
import { type FrozenModel, ModelGuard } from "./model-guard.ts";
import type { ModelRoute } from "./model-route.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

const log = logger("claude-client");
/** The adapter's own stderr, republished line by line under its own target. */
const adapterLog = logger("claude-agent-acp");

/** How long the adapter may take to accept a platform route before `agent/start` fails. */
const ROUTE_TIMEOUT_MS = 10_000;

/** Prefix of the request ids this bridge sends on its own; Ora's ids are numbers or its own text. */
const ROUTE_REQUEST_PREFIX = "ora-claude-model-route-";

/** The subset of a spawned child process this bridge depends on, so tests can substitute one. */
export interface SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  readonly pid: number | undefined;
  kill(): void;
  readonly exited: Promise<void>;
}

export interface ClaudeClientOptions {
  /**
   * Overrides process spawning; injected by tests. Production spawns through `attachProcesses`.
   *
   * Which program a spawn resolves to is `command.ts`'s decision and is deliberately not a
   * parameter here: this class owns the adapter's lifetime, not the question of where it lives.
   */
  spawn?: (cwd: string, env: Record<string, string>) => SpawnedProcess;
  /** Receives every ACP frame emitted by the adapter, in output order. */
  onAcpFrame?: (frame: JsonValue) => void;
  /** Invoked after the adapter exits on its own, never after an explicit stop. */
  onExited?: () => void;
}

interface RunningProcess {
  process: SpawnedProcess;
  stdinWriter: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * Owns one `claude-agent-acp` subprocess and bridges ACP frames between its stdio and Ora.
 *
 * The adapter is a native ACP server: it takes no subcommand and no arguments, reads its initial
 * directory from the spawn cwd, and receives every per-session directory through ACP `session/new`.
 * The plugin owns its whole lifetime — spawn on `agent/start`, kill on `agent/stop`, respawn on an
 * Effect `reactivate` — so Ora never sees the child's stdio, which is what lets Claude Code use ACP
 * methods this host has never heard of. Without a platform route nothing here parses ACP; frames
 * are re-framed between Ora's binary envelope and the adapter's NDJSON and otherwise passed
 * through verbatim. With one, {@link ModelGuard} reads the frames that could change the route or
 * the model.
 */
export class ClaudeClient {
  readonly #spawn: (
    cwd: string,
    env: Record<string, string>,
  ) => SpawnedProcess | Promise<SpawnedProcess>;
  readonly #onAcpFrame: (frame: JsonValue) => void;
  readonly #onExited: () => void;
  /** Supplied by `attachProcesses` once the plugin's `Plugin` instance exists; see `main.ts`. */
  #processes: HostProcesses | undefined;
  #running: RunningProcess | undefined;
  #expectedExit = false;
  /** The platform route every generation of the adapter starts with; absent on a local host. */
  #route: ModelRoute | undefined;
  /** Holds every ACP frame of a platform-model execution to its route and model. */
  #guard: ModelGuard | undefined;
  /** This bridge's own outstanding requests, answered from stdout and never forwarded to Ora. */
  readonly #pending = new Map<string, (frame: JsonValue) => void>();
  #nextRequest = 0;

  constructor(options: ClaudeClientOptions = {}) {
    this.#spawn = options.spawn ??
      ((cwd, env) => this.#spawnViaHost(cwd, env));
    this.#onAcpFrame = options.onAcpFrame ?? (() => {});
    this.#onExited = options.onExited ?? (() => {});
  }

  /** The only model a platform route may use; `undefined` keeps the adapter's own discovery. */
  get frozenModel(): FrozenModel | undefined {
    return this.#guard?.model;
  }

  get running(): boolean {
    return this.#running !== undefined;
  }

  /**
   * Supplies the host-managed process client this plugin spawns `claude-agent-acp` through.
   *
   * Called once, from `onActivate`: the `Plugin` instance `createHostProcesses` needs does not
   * exist yet when this client is constructed as a class field, so production spawning stays
   * unavailable until this runs. Tests that inject `options.spawn` never need to call it.
   */
  attachProcesses(processes: HostProcesses): void {
    this.#processes = processes;
  }

  /**
   * Fixes the platform route for every later start, including an Effect restart.
   *
   * One plugin process serves one execution, so the route is set once per `agent/start` and never
   * switched between users while sessions run; `undefined` returns to the adapter's own routing.
   */
  useRoute(route: ModelRoute | undefined): void {
    this.#route = route;
    this.#guard = route === undefined ? undefined : new ModelGuard(route.model);
  }

  /**
   * Spawns the ACP adapter in the given working directory and starts bridging its stdio.
   *
   * Any previous child is stopped first so a restart cannot leave two adapters writing frames into
   * the same host connection. With a platform route, the adapter only counts as started once it
   * accepted that route: a session created before `providers/set` would run on whatever routing
   * Claude Code found by itself.
   */
  async start(cwd: string): Promise<void> {
    const restarting = this.#running !== undefined;
    await this.stop();
    this.#expectedExit = false;

    log.info(restarting ? "restarting the adapter" : "starting the adapter", {
      context: { cwd },
    });
    // Failures are already classified for Ora by `spawnClaude`: an adapter this machine does not
    // have stays retryable, while a pin naming a missing executable says so by name.
    let process: SpawnedProcess;
    try {
      process = await this.#spawn(cwd, { ...this.#route?.environment });
    } catch (error) {
      log.warn("the adapter could not be spawned", { context: { cwd }, error });
      throw error;
    }
    this.#running = { process, stdinWriter: process.stdin.getWriter() };
    this.#attach(process);
    const route = this.#route;
    if (route !== undefined) {
      try {
        await this.#applyRoute(route);
      } catch (error) {
        await this.stop();
        throw error;
      }
    }
    log.info("adapter running", {
      context: { cwd, pid: process.pid, platformRoute: route !== undefined },
    });
  }

  /**
   * Hands the adapter its platform route through `providers/set` and waits for it to be accepted.
   *
   * The request goes straight into the adapter's stdin with an id of this bridge's own, and its
   * answer is consumed by `#pumpStdout` before anything is forwarded, so Ora never sees either
   * frame. Neither the params nor an error payload is logged: the header carries the token.
   */
  async #applyRoute(route: ModelRoute): Promise<void> {
    const id = `${ROUTE_REQUEST_PREFIX}${++this.#nextRequest}`;
    const answered = new Promise<JsonValue>((resolve) => {
      this.#pending.set(id, resolve);
    });
    let timer: number | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ROUTE_TIMEOUT_MS);
    });
    try {
      await this.#write({
        jsonrpc: "2.0",
        id,
        method: "providers/set",
        params: {
          providerId: route.provider.providerId,
          apiType: route.provider.apiType,
          baseUrl: route.provider.baseUrl,
          headers: { ...route.provider.headers },
        },
      });
      const answer = await Promise.race([answered, timedOut]);
      const accepted = answer !== undefined && typeof answer === "object" &&
        answer !== null && !Array.isArray(answer) && "result" in answer &&
        !("error" in answer);
      if (!accepted) {
        log.warn("the adapter did not accept the platform model route", {
          context: { timedOut: answer === undefined },
        });
        throw new PluginMethodError(
          AGENT_UNUSABLE,
          "the Claude ACP adapter did not accept the platform model route",
        );
      }
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  /**
   * Forwards one host ACP frame into the adapter's stdin as NDJSON.
   *
   * Awaiting the write is what lets the adapter's backpressure reach the host instead of growing
   * an unbounded queue inside this process.
   *
   * On a platform route, every frame from Ora passes the {@link ModelGuard} first: a request that
   * would replace the route or the model is answered here with an error and never reaches the
   * adapter, which is the only way to keep a client from undoing what `providers/set` applied.
   */
  async writeAcp(frame: JsonValue): Promise<void> {
    const decision = this.#guard?.inbound(frame) ?? { forward: frame };
    if ("reply" in decision) {
      log.info(
        "answered a host ACP request the platform route does not allow",
        {
          context: summarize(frame),
        },
      );
      this.#onAcpFrame(decision.reply);
      return;
    }
    if ("drop" in decision) {
      log.info(
        "dropped a host ACP notification the platform route does not allow",
        {
          context: summarize(frame),
        },
      );
      return;
    }
    await this.#write(decision.forward);
  }

  /** Writes one frame into the adapter's stdin as-is; this bridge's own requests come here. */
  async #write(frame: JsonValue): Promise<void> {
    const running = this.#running;
    if (running === undefined) {
      throw new Error("the Claude agent is not running");
    }
    try {
      await running.stdinWriter.write(encodeLine(JSON.stringify(frame)));
    } catch (error) {
      log.warn("writing an ACP frame to the adapter failed", {
        context: { pid: running.process.pid },
        error,
      });
      throw error;
    }
  }

  /** Kills the adapter and releases every pipe; idempotent when already stopped. */
  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = undefined;
    this.#expectedExit = true;
    if (running === undefined) {
      log.debug("stop requested with no adapter running");
      return;
    }
    log.info("stopping the adapter", { context: { pid: running.process.pid } });
    try {
      await running.stdinWriter.close();
    } catch {
      // The child already exited and closed its stdin; nothing is left to flush.
    }
    try {
      running.process.kill();
    } catch {
      // Already dead.
    }
  }

  /** Wires stdout, stderr, and exit bookkeeping for one live child. */
  #attach(process: SpawnedProcess): void {
    void this.#pumpStdout(process);
    void this.#pumpStderr(process);
    void process.exited.then(() => {
      // A process that is no longer `#running` was already superseded by a later `start()` (an
      // Effect restart, for instance); its death is old news, not a live agent going away, so it
      // must never clear the new process's tracking or fire `onExited` regardless of the shared
      // `#expectedExit` flag, which by then reflects the newer generation's intent, not this one's.
      if (this.#running?.process !== process) {
        log.debug("a superseded adapter generation exited", {
          context: { pid: process.pid },
        });
        return;
      }
      this.#running = undefined;
      if (this.#expectedExit) {
        log.info("adapter exited after stop", {
          context: { pid: process.pid },
        });
      } else {
        log.warn("claude-agent-acp exited unexpectedly", {
          context: { pid: process.pid },
        });
        this.#onExited();
      }
    });
  }

  /**
   * Forwards every NDJSON line the adapter prints as one ACP frame.
   *
   * A line that is not a JSON object is dropped with a warning rather than failing the bridge: Ora
   * rejects non-object frames anyway, and one stray diagnostic line must not end every live session
   * on this agent.
   */
  async #pumpStdout(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stdout)) {
        let frame: JsonValue;
        try {
          frame = JSON.parse(line) as JsonValue;
        } catch {
          // The line itself is logged: it is the adapter's own output on its protocol channel,
          // and the only clue to what went wrong with the pairing.
          log.warn("dropping a non-JSON stdout line from the adapter", {
            context: { pid: process.pid, line: line.slice(0, 512) },
          });
          continue;
        }
        if (
          frame === null || typeof frame !== "object" || Array.isArray(frame)
        ) {
          log.warn("dropping a non-object ACP frame from the adapter", {
            context: { pid: process.pid },
          });
          continue;
        }
        const own = typeof frame.id === "string"
          ? this.#pending.get(frame.id)
          : undefined;
        if (own !== undefined && !("method" in frame)) {
          own(frame);
          continue;
        }
        log.debug("adapter ACP frame received", {
          context: { pid: process.pid, ...summarize(frame) },
        });
        this.#onAcpFrame(this.#guard?.outbound(frame) ?? frame);
      }
      log.debug("adapter stdout reached EOF", {
        context: { pid: process.pid },
      });
    } catch (error) {
      log.warn("claude-agent-acp stdout read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Republishes the adapter's diagnostics into this plugin's log, one record per line.
   *
   * The adapter is a third party whose stderr severity this plugin cannot know, so every line is
   * recorded at `info` under its own target rather than guessed at; the host's per-plugin level
   * decides whether it is kept.
   */
  async #pumpStderr(process: SpawnedProcess): Promise<void> {
    try {
      for await (const line of decodeLines(process.stderr)) {
        if (line.length > 0) {
          adapterLog.info(line, { context: { pid: process.pid } });
        }
      }
    } catch (error) {
      log.warn("claude-agent-acp stderr read failed", {
        context: { pid: process.pid },
        error,
      });
    }
  }

  /**
   * Asks the host to spawn and own the adapter process, adapting its `HostChildProcess` handle
   * onto `SpawnedProcess` so every other method above stays unaware of who owns the OS process.
   */
  async #spawnViaHost(
    cwd: string,
    env: Record<string, string>,
  ): Promise<SpawnedProcess> {
    if (this.#processes === undefined) {
      throw new Error(
        "ClaudeClient cannot spawn before attachProcesses() runs",
      );
    }
    // A platform route runs only the pair this package ships; see `spawnBundledClaude`.
    const child = this.#route === undefined
      ? await spawnClaude(this.#processes, { cwd, env })
      : await spawnBundledClaude(this.#processes, { cwd, env });
    return {
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => child.write(chunk),
        close: () => child.closeStdin(),
      }),
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      // Best effort: the host already treats kill() as idempotent and tolerant of a process
      // that is already gone, so a rejection here is nothing callers need to observe.
      kill: () => void child.kill().catch(() => {}),
      exited: child.exited.then(() => undefined),
    };
  }
}

/** The envelope fields of one frame that are safe to log: never its params or result. */
function summarize(frame: JsonValue): Record<string, unknown> {
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    return {};
  }
  return {
    method: typeof frame.method === "string" ? frame.method : undefined,
    id: typeof frame.id === "string" || typeof frame.id === "number"
      ? frame.id
      : undefined,
  };
}
