import type {
  AgentEffectCoordinationContext,
  AgentEffectDefinition,
  AgentEffectReadinessContext,
  EffectResourceDeclaration,
  JsonValue,
} from "@ora-space/plugin-sdk";
import { PluginMethodError, SKILL_DIRECTORY_V1 } from "@ora-space/plugin-sdk";
import type { ClaudeClient } from "../services/claude-client.ts";
import { logger } from "../services/log.ts";
import { invalidateClaudeModels } from "./models.ts";

const log = logger("effects");

/**
 * The Skill surface Claude Code reads: a project-relative `.claude/skills/<name>/SKILL.md` tree.
 *
 * Claude Code also reads a user-level `~/.claude/skills` directory, but that is Preserved State
 * from this plugin's point of view: Ora only manages the repository-root surface it declares here,
 * so it never fights another tool over the user-level directory.
 */
export const SKILLS_RESOURCE: EffectResourceDeclaration = {
  workspaceRelativePath: ".claude/skills",
  materializationFormat: SKILL_DIRECTORY_V1,
  coordination: "quiesce_before_mutation",
};

const SESSION_PROMPT_METHOD = "session/prompt";

/** The code this plugin reports a Consumer call it cannot satisfy right now under. */
const CONSUMER_NOT_READY = -32000;

/**
 * How long `effect/coordinate` waits for in-flight turns before reporting the Target still busy.
 *
 * Ora allows a plugin control call 30 seconds and coordination holds that call open, so this has
 * to finish well inside it. Waiting at all is worth it because the common case is a turn seconds
 * from finishing; past that the honest answer is to fail this attempt and let Ora's reconcile
 * schedule bring the mutation back, rather than hold a host call for the length of a prompt that
 * may legitimately run for minutes.
 */
const QUIESCE_TIMEOUT_MS = 10_000;

/** How often the drain loop rechecks whether every in-flight turn has answered. */
const QUIESCE_POLL_MS = 50;

/**
 * Coordinates the `.claude/skills` Effect Resource against the one adapter process this plugin owns.
 *
 * Claude Code resolves its Skill directories when a session starts, so a Skill edit on disk only
 * reaches a session created after the edit. Respawning covers that: the adapter serving the next
 * turn is always one that started after the write.
 *
 * In-flight `session/prompt` turns are tracked from the ACP frames already flowing through the
 * bridge — nothing here parses ACP beyond `method` and `id` — and Ora's three Consumer calls are
 * answered around that: `coordinate` holds new turns behind a barrier and waits for the running
 * ones, `reactivate` respawns the adapter and replays what was held, and `verifyReady` reports
 * whether the process Ora is about to mark ready is one that has actually read the Skills on disk.
 */
export class SkillEffectCoordinator {
  readonly #client: ClaudeClient;
  readonly #cwd: () => string | undefined;
  readonly #openTurns = new Set<string | number>();
  /** `undefined` while no barrier is held; an array from the moment `coordinate` engages one. */
  #held: JsonValue[] | undefined;

  constructor(client: ClaudeClient, cwd: () => string | undefined) {
    this.#client = client;
    this.#cwd = cwd;
  }

  readonly definition: AgentEffectDefinition = {
    resources: [SKILLS_RESOURCE],
    coordinate: (context) => this.#coordinate(context),
    reactivate: (context) => this.#reactivate(context),
    verifyReady: (context) => this.#verifyReady(context),
  };

  /**
   * Observes one host-to-agent frame before it would be forwarded, absorbing it instead if the
   * barrier is holding new turns. Returns whether the frame was absorbed.
   */
  intercept(frame: JsonValue): boolean {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return false;
    }
    const { method, id } = frame;
    if (
      typeof method !== "string" ||
      (typeof id !== "string" && typeof id !== "number")
    ) {
      return false;
    }
    if (method !== SESSION_PROMPT_METHOD) {
      return false;
    }
    if (this.#held !== undefined) {
      this.#held.push(frame);
      log.info("new turn held behind the Skill barrier", {
        context: { turnId: id, held: this.#held.length },
      });
      return true;
    }
    this.#openTurns.add(id);
    log.debug("turn opened", {
      context: { turnId: id, openTurns: this.#openTurns.size },
    });
    return false;
  }

  /** Observes one agent-to-host frame, clearing turn tracking once a prompt resolves. */
  observe(frame: JsonValue): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      return;
    }
    if ("method" in frame) {
      return; // requests and notifications the adapter sends are not responses.
    }
    const { id } = frame;
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    if (this.#openTurns.delete(id)) {
      log.debug("turn resolved", {
        context: { turnId: id, openTurns: this.#openTurns.size },
      });
    }
  }

  /**
   * Engages the new-turn barrier, then reports safe to mutate once every running turn has
   * answered.
   *
   * The barrier goes up before the wait, not after it. A check that only latched on an observed
   * idle moment would never find one in a workspace whose prompts keep arriving; holding first
   * makes the set of turns to wait for finite, so the wait always terminates.
   *
   * Idempotent, as Ora requires of both coordination calls: a repeat finds the barrier already up
   * and the turn set already drained, and returns without touching anything.
   */
  async #coordinate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    const repeated = this.#held !== undefined;
    this.#held ??= [];
    log.info(
      repeated
        ? "effect/coordinate repeated; barrier already engaged"
        : "effect/coordinate engaged the Skill barrier",
      {
        method: "effect/coordinate",
        context: {
          targetId: context.targetId,
          openTurns: this.#openTurns.size,
        },
      },
    );
    const startedAt = Date.now();
    const deadline = startedAt + QUIESCE_TIMEOUT_MS;
    while (this.#openTurns.size > 0) {
      if (Date.now() >= deadline) {
        // Ora only reactivates Targets whose coordination succeeded, so a barrier abandoned here
        // would hold its queued prompts for the life of the process. Release before failing, and
        // let the next reconcile attempt engage a fresh one.
        const stranded = this.#openTurns.size;
        log.warn("effect/coordinate gave up waiting for in-flight turns", {
          method: "effect/coordinate",
          context: {
            targetId: context.targetId,
            stranded,
            waitedMs: Date.now() - startedAt,
          },
        });
        await this.#release();
        throw new PluginMethodError(
          CONSUMER_NOT_READY,
          `Claude Code still has ${stranded} turn(s) in flight`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, QUIESCE_POLL_MS));
    }
    log.info("Skill Target is safe to mutate", {
      method: "effect/coordinate",
      context: {
        targetId: context.targetId,
        waitedMs: Date.now() - startedAt,
      },
    });
    return { targetId: context.targetId, state: "safe_to_mutate" };
  }

  /**
   * Restarts the adapter so the next session it creates resolves `.claude/skills` fresh, then
   * replays every held turn in order.
   *
   * The barrier is the idempotence marker: a repeat call finds none held — exactly the state a
   * finished reactivation leaves behind — and does not restart an adapter that has already
   * rescanned, which would tear down the sessions that came back after the first restart.
   */
  async #reactivate(
    context: AgentEffectCoordinationContext,
  ): Promise<JsonValue> {
    if (this.#held === undefined) {
      log.info("effect/reactivate repeated; nothing held, adapter left as is", {
        method: "effect/reactivate",
        context: { targetId: context.targetId },
      });
      return { targetId: context.targetId, state: "reactivated" };
    }
    const cwd = this.#cwd();
    log.info("effect/reactivate restarting the adapter to rescan Skills", {
      method: "effect/reactivate",
      context: { targetId: context.targetId, cwd, held: this.#held.length },
    });
    if (cwd !== undefined) {
      invalidateClaudeModels(cwd);
      await this.#client.start(cwd);
    } else {
      log.warn("effect/reactivate has no workspace to restart the adapter in", {
        method: "effect/reactivate",
        context: { targetId: context.targetId },
      });
    }
    await this.#release();
    log.info("Skill barrier released", {
      method: "effect/reactivate",
      context: { targetId: context.targetId },
    });
    return { targetId: context.targetId, state: "reactivated" };
  }

  /**
   * Reports whether the running adapter can consume this exact Target projection.
   *
   * The proof this plugin can offer is that a process is up and no mutation is mid-flight: every
   * Skill write is followed by a restart, so an adapter running outside a coordination episode is
   * one that started after the last write and has read what is on disk. Anything else throws,
   * which is how a Consumer says "not ready" — Ora records readiness only from a call that
   * returned.
   */
  #verifyReady(context: AgentEffectReadinessContext): JsonValue {
    if (!this.#client.ready) {
      log.info("effect/verify_ready: not ready, adapter not running", {
        method: "effect/verify_ready",
        context: { targetId: context.targetId },
      });
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "the Claude Code adapter is not running, so it has read no Skills",
      );
    }
    if (this.#held !== undefined) {
      log.info("effect/verify_ready: not ready, barrier still engaged", {
        method: "effect/verify_ready",
        context: { targetId: context.targetId, held: this.#held.length },
      });
      throw new PluginMethodError(
        CONSUMER_NOT_READY,
        "Claude Code is quiesced for a Skill mutation and has not rescanned yet",
      );
    }
    log.info("effect/verify_ready: ready", {
      method: "effect/verify_ready",
      context: {
        targetId: context.targetId,
        generation: context.generation,
        consumerRevisionId: context.consumerRevisionId,
      },
    });
    return {
      targetId: context.targetId,
      generation: context.generation,
      consumerRevisionId: context.consumerRevisionId,
      projectionDigest: context.projectionDigest,
    };
  }

  /**
   * Drains every held turn into the adapter, then lets new ones through again.
   *
   * The queue length is rechecked on every iteration rather than snapshotted, so a
   * `session/prompt` that `intercept` absorbs while the drain is still running is replayed in this
   * pass instead of being stranded behind a barrier that is about to come down.
   */
  async #release(): Promise<void> {
    let replayed = 0;
    while (this.#held !== undefined && this.#held.length > 0) {
      const frame = this.#held.shift();
      if (frame !== undefined) {
        await this.#client.writeAcp(frame);
        replayed += 1;
      }
    }
    this.#held = undefined;
    if (replayed > 0) {
      log.info("replayed held turns into the adapter", {
        context: { replayed },
      });
    }
  }
}
