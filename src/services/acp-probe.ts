import type { HostChildProcess, JsonValue } from "@ora-space/plugin-sdk";
import { METHOD_NOT_FOUND } from "@ora-space/plugin-sdk";
import { logger } from "./log.ts";
import { decodeLines, encodeLine } from "./ndjson.ts";

const log = logger("acp-probe");
/** The probe adapter's own stderr, kept at debug: discovery runs often and usually succeeds. */
const probeLog = logger("claude-agent-acp.probe");

/**
 * How long one whole probe conversation may take before it is abandoned.
 *
 * Ora gives `agent/discover` a deadline (60 seconds today), and discovery caps the conversation
 * further at that deadline less the cleanup reserve. The budget covers the conversation rather than each request, so a
 * slow `initialize` cannot be followed by an equally slow `session/new` and overrun the host's own
 * deadline — which would fail discovery with a timeout naming the host instead of the adapter.
 */
export const PROBE_BUDGET_MS = 40_000;

/** One probe request still waiting for the adapter's answer, keyed by its JSON-RPC id. */
interface PendingCall {
  resolve: (result: JsonValue) => void;
  reject: (error: Error) => void;
}

/** One caller waiting in a {@link NotificationRecord} for a notification it has not seen yet. */
interface NotificationWait {
  which: (params: JsonValue) => boolean;
  resolve: (params: JsonValue) => void;
  reject: (error: Error) => void;
}

/**
 * The notifications of one kind a probe has received since the record began, kept until asked.
 *
 * Kept rather than handed to a single waiter, because which one is wanted may only be known later:
 * an agent can report on a session before it answers the `session/new` that names the session.
 */
export class NotificationRecord {
  readonly #seen: JsonValue[] = [];
  readonly #waits = new Set<NotificationWait>();
  #ended: Error | undefined;

  constructor(readonly matches: (params: JsonValue) => boolean) {}

  /**
   * Resolves with the first recorded notification `which` accepts, already received or still to
   * come. It rejects once the conversation ends without one.
   */
  first(which: (params: JsonValue) => boolean): Promise<JsonValue> {
    const seen = this.#seen.find(which);
    if (seen !== undefined) {
      return Promise.resolve(seen);
    }
    if (this.#ended !== undefined) {
      return Promise.reject(this.#ended);
    }
    return new Promise((resolve, reject) => {
      this.#waits.add({ which, resolve, reject });
    });
  }

  /** Keeps one notification and hands it to whoever was waiting for one like it. */
  add(params: JsonValue): void {
    this.#seen.push(params);
    for (const wait of [...this.#waits]) {
      if (wait.which(params)) {
        this.#waits.delete(wait);
        wait.resolve(params);
      }
    }
  }

  /** Fails every wait still open; what was already recorded can still be asked for. */
  end(error: Error): void {
    this.#ended ??= error;
    const waits = [...this.#waits];
    this.#waits.clear();
    for (const wait of waits) {
      wait.reject(error);
    }
  }
}

/** A probe conversation that ended without the answer it asked for. */
export class AcpProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProbeError";
  }
}

/**
 * Speaks ACP to one short-lived adapter process the plugin questions and then discards.
 *
 * This is deliberately not the live bridge in the `*-client.ts` sibling. That one is a pipe: Ora
 * owns both ends of the conversation and this plugin never injects a request of its own into it.
 * A probe is the opposite — this plugin is the ACP *client*, asking a question Ora knows nothing
 * about — so it needs its own request/response correlation and, above all, its own process. A
 * request injected into the connection Ora is reading would return its answer down Ora's pipe, and
 * the capabilities Ora declares in its own `initialize` are what decide whether the agent reports a
 * model selector at all.
 *
 * Nothing here is specific to any one adapter: the caller supplies an already-spawned host-owned
 * process and decides which conversation to hold on it.
 */
export class AcpProbe {
  readonly #child: HostChildProcess;
  readonly #pending = new Map<number, PendingCall>();
  readonly #records = new Set<NotificationRecord>();
  readonly #deadline: number;
  #nextId = 1;
  /** Set once the adapter can no longer answer, so later calls fail instead of waiting forever. */
  #ended: Error | undefined;

  private constructor(child: HostChildProcess, deadline: number) {
    this.#child = child;
    this.#deadline = deadline;
  }

  /**
   * Starts reading one spawned process as an ACP peer.
   *
   * The process must already be running: resolving which executable to run is the caller's
   * decision, and the failures that resolution raises — an adapter that is not installed, one that
   * cannot run — are classifications Ora acts on, which would be flattened into an undifferentiated
   * probe error here.
   */
  static attach(
    child: HostChildProcess,
    deadline: number = Date.now() + PROBE_BUDGET_MS,
  ): AcpProbe {
    const probe = new AcpProbe(child, deadline);
    void probe.#pumpStdout();
    void probe.#pumpStderr();
    void child.exited.then(({ code, signal }) => {
      probe.#end(
        new AcpProbeError(
          `the probe adapter exited (code ${code}, signal ${signal}) before answering`,
        ),
      );
    });
    return probe;
  }

  /**
   * Sends one ACP request and resolves with its result, within the conversation's deadline.
   *
   * `deadline` replaces it for this one request: cleanup after the conversation keeps time of its
   * own the conversation must not use.
   */
  async request(
    method: string,
    params: JsonValue,
    deadline: number = this.#deadline,
  ): Promise<JsonValue> {
    if (this.#ended !== undefined) {
      throw this.#ended;
    }
    const id = this.#nextId++;
    const answered = new Promise<JsonValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw new AcpProbeError(`failed to send ${method}: ${describe(error)}`);
    }
    return await this.#withinDeadline(answered, id, method, deadline);
  }

  /**
   * Starts keeping every notification `matches` accepts, from now until the conversation ends.
   *
   * Start it before sending the request that provokes them: an agent may notify before it answers.
   * Responses are never recorded.
   */
  record(matches: (params: JsonValue) => boolean): NotificationRecord {
    const record = new NotificationRecord(matches);
    if (this.#ended !== undefined) {
      record.end(this.#ended);
    } else {
      this.#records.add(record);
    }
    return record;
  }

  /** Kills the probed process; idempotent, and safe on one that already exited. */
  async close(): Promise<void> {
    this.#end(new AcpProbeError("the probe was closed"));
    try {
      await this.#child.kill();
    } catch {
      // Best effort: the host treats kill as idempotent and the process may already be gone, and
      // it reaps whatever survives when this plugin generation stops regardless.
    }
  }

  /** Fails one pending call once the conversation's shared deadline passes. */
  #withinDeadline(
    answered: Promise<JsonValue>,
    id: number,
    method: string,
    deadline: number,
  ): Promise<JsonValue> {
    const remaining = Math.max(0, deadline - Date.now());
    let timer: number | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new AcpProbeError(
            `${method} did not answer before the probe's deadline`,
          ),
        );
      }, remaining);
    });
    return Promise.race([answered, expiry]).finally(() => clearTimeout(timer));
  }

  /** Routes one decoded frame to the call waiting for it. */
  #dispatch(frame: JsonValue): void {
    if (!isRecord(frame)) {
      return;
    }
    if (typeof frame.method === "string") {
      const id = frame.id;
      if (typeof id === "number" || typeof id === "string") {
        // The agent is asking the probe's client side for something. A probe advertises no
        // client capabilities and has no user to prompt, so the only honest answer is a refusal —
        // and it has to be sent, because an ACP request left unanswered stalls the handshake this
        // probe is in the middle of rather than being quietly forgotten.
        void this.#refuse(id, frame.method);
      } else {
        // A notification, such as the command report discovery may be waiting for.
        this.#notify(frame.params ?? null);
      }
      return;
    }
    const id = frame.id;
    if (typeof id !== "number") {
      return;
    }
    const call = this.#pending.get(id);
    if (call === undefined) {
      return;
    }
    this.#pending.delete(id);
    if (isRecord(frame.error)) {
      const message = typeof frame.error.message === "string"
        ? frame.error.message
        : JSON.stringify(frame.error);
      call.reject(new AcpProbeError(message));
      return;
    }
    call.resolve(frame.result ?? null);
  }

  /** Hands one notification to every record that keeps its kind. */
  #notify(params: JsonValue): void {
    for (const record of this.#records) {
      if (record.matches(params)) {
        record.add(params);
      }
    }
  }

  /** Tells the agent this probe serves no client methods, without failing the conversation. */
  async #refuse(id: number | string, method: string): Promise<void> {
    try {
      await this.#send({
        jsonrpc: "2.0",
        id,
        error: {
          code: METHOD_NOT_FOUND,
          message: `${method} is not available during model discovery`,
        },
      });
    } catch (error) {
      log.debug("probe could not refuse a client method", {
        context: { method },
        error,
      });
    }
  }

  /** Writes one frame to the probed process as NDJSON. */
  #send(frame: JsonValue): Promise<void> {
    return this.#child.write(encodeLine(JSON.stringify(frame)));
  }

  /** Reads stdout until it closes, dispatching every ACP frame the process prints. */
  async #pumpStdout(): Promise<void> {
    try {
      for await (const line of decodeLines(this.#child.stdout)) {
        let frame: JsonValue;
        try {
          frame = JSON.parse(line) as JsonValue;
        } catch {
          log.debug("probe dropped a non-JSON stdout line", {
            context: { line: line.slice(0, 512) },
          });
          continue;
        }
        this.#dispatch(frame);
      }
      this.#end(new AcpProbeError("the probe adapter closed its ACP stream"));
    } catch (error) {
      this.#end(
        new AcpProbeError(`probe stdout read failed: ${describe(error)}`),
      );
    }
  }

  /**
   * Drains stderr so a chatty adapter cannot grow an unread buffer for the probe's lifetime, and
   * keeps the diagnostics that explain a handshake which never completed.
   */
  async #pumpStderr(): Promise<void> {
    try {
      for await (const line of decodeLines(this.#child.stderr)) {
        if (line.length > 0) {
          probeLog.debug(line);
        }
      }
    } catch {
      // The process is gone; whatever ended the stream is already reported through `#end`.
    }
  }

  /** Ends the conversation, failing every call still waiting. The first cause is the one kept. */
  #end(error: Error): void {
    this.#ended ??= error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const call of pending) {
      call.reject(this.#ended);
    }
    for (const record of this.#records) {
      record.end(this.#ended);
    }
    this.#records.clear();
  }
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Renders any thrown value as a message safe to carry into a probe error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
