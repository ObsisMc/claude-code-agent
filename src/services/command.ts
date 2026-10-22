import {
  AGENT_NOT_INSTALLED,
  AGENT_UNUSABLE,
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  HostRequestError,
  PluginMethodError,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";
import { bundledAdapterPath } from "./bundled-binary.ts";
import { logger } from "./log.ts";

const log = logger("command");

/** The npm bin name of the ACP adapter that fronts Claude Code. */
const BINARY_NAME = "claude-agent-acp";

/** Pins one exact executable, bypassing PATH resolution entirely. */
export const BIN_ENV_VAR = "ORA_CLAUDE_ACP_BIN";

/**
 * Names the PATH spellings that can launch Claude Code's ACP adapter, in the order they should be
 * tried.
 *
 * Windows gets four: Windows installers disagree about what they put on PATH, and the host's PATH
 * lookup only appends `.exe` to a bare name — it does not try the others — so every spelling a
 * real installer produces has to be named here or the adapter is reported missing on a machine
 * that has it. `claude-agent-acp` is an npm-published binary, so a `.cmd`/`.bat` shim is the
 * common case rather than the exception. The order follows Windows' own `PATHEXT` precedence:
 * `.exe` first, so the process the host ends up holding is the adapter itself rather than a shell
 * wrapper around it.
 */
export function resolveClaudeCommands(): string[] {
  return Deno.build.os === "windows"
    ? [
      `${BINARY_NAME}.exe`,
      `${BINARY_NAME}.cmd`,
      `${BINARY_NAME}.bat`,
      BINARY_NAME,
    ]
    : [BINARY_NAME];
}

/**
 * Spawns Claude Code's ACP adapter through the host, preferring the one this package ships.
 *
 * The host owns the OS process rather than this sandboxed runtime: it terminates process trees
 * and reclaims every child this plugin generation left behind, which a plugin spawning its own
 * `Deno.Command` cannot promise — least of all through a Windows `.cmd`/`.bat` shim, where the
 * handle a plugin holds is the shim and the real adapter underneath it can outlive a kill of the
 * wrapper.
 *
 * Both ways of reaching an adapter are named, because this source cannot know at build time which
 * package it ended up in. `spawnAgentProcess` answers that at spawn time: it asks for the bundled
 * adapter first and falls through to a PATH lookup only when the host reports that this package
 * carries no such file, which is how a package built without a bundled adapter announces itself.
 * A bundled adapter that is present but cannot run is a property of the package rather than of
 * this machine, so it fails the agent outright instead of quietly running some other adapter.
 *
 * `ORA_CLAUDE_ACP_BIN` outranks both, and is used alone: a pin that quietly fell back to whatever
 * is on PATH would run a different adapter than the user asked for. It pins the adapter only —
 * the Claude Code CLI the adapter then drives is pinned separately, with `ORA_CLAUDE_BIN`, which
 * is read inside the adapter process rather than here.
 */
export function spawnClaude(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const pinned = readEnv(BIN_ENV_VAR)?.trim();
  if (pinned !== undefined && pinned !== "") {
    log.info("spawning the pinned adapter", {
      context: { cwd: invocation.cwd, command: pinned, pin: BIN_ENV_VAR },
    });
    return spawnPinned(processes, pinned, invocation);
  }
  return spawnResolved(processes, invocation);
}

/**
 * Spawns only the adapter this package ships, for a platform-model execution.
 *
 * A platform route is applied to, and tested against, the adapter and CLI pair this package
 * bundles; `ORA_CLAUDE_ACP_BIN` or an install on PATH could be any other build, with any other
 * idea of how a route's environment and settings combine. So neither is consulted, and a package
 * that cannot run its own adapter fails the start as `AGENT_UNUSABLE` rather than looking further.
 * The CLI the adapter drives is held to the bundled one by `ORA_CLAUDE_BUNDLED_CLI_ONLY` in the
 * route's environment, which `scripts/adapter-entry.mjs` reads.
 */
export async function spawnBundledClaude(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const packageCommand = bundledAdapterPath();
  log.info("spawning the bundled adapter for a platform route", {
    context: { cwd: invocation.cwd, packageCommand },
  });
  try {
    return await processes.spawn({ packageCommand, ...invocation });
  } catch (error) {
    log.warn("the bundled adapter could not be spawned", {
      context: { cwd: invocation.cwd, packageCommand },
      error,
    });
    throw new PluginMethodError(
      AGENT_UNUSABLE,
      "this package's bundled Claude ACP adapter cannot run, and a platform model route uses no other",
    );
  }
}

/**
 * Runs the bundled adapter, or resolves one off PATH, replacing the SDK's generic "not found"
 * message with one that names the npm package a user can install and the env var that bypasses
 * PATH entirely.
 *
 * The replacement only ever applies to the PATH half of the ladder: a package that ships an
 * adapter never reaches it, and a bundled adapter that fails raises `AGENT_UNUSABLE` from inside
 * `spawnAgentProcess`, which is a different code and must not be relabelled as "not installed"
 * and retried forever.
 */
async function spawnResolved(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const candidates = resolveClaudeCommands();
  const packageCommand = bundledAdapterPath();
  log.info("spawning the adapter", {
    context: {
      cwd: invocation.cwd,
      packageCommand,
      pathCandidates: candidates,
    },
  });
  try {
    const child = await spawnAgentProcess(
      processes,
      { packageCommand, command: candidates },
      invocation,
    );
    log.info("adapter spawned", {
      context: { cwd: invocation.cwd, pid: child.pid },
    });
    return child;
  } catch (error) {
    if (
      error instanceof PluginMethodError && error.code === AGENT_NOT_INSTALLED
    ) {
      log.warn("no adapter found in the package or on PATH", {
        context: { packageCommand, pathCandidates: candidates },
      });
      throw new PluginMethodError(
        AGENT_NOT_INSTALLED,
        `Claude Code's ACP adapter is not installed or not on PATH (tried: ${
          candidates.join(", ")
        }); install it with \`npm i -g @agentclientprotocol/claude-agent-acp\` or set ${BIN_ENV_VAR}`,
      );
    }
    throw error;
  }
}

/**
 * Spawns the adapter a user named explicitly, reporting an absent one as local configuration.
 *
 * A pin pointing at nothing is the same kind of fault as an uninstalled adapter — fixable without
 * restarting Ora — so it stays retryable rather than failing this agent outright.
 */
async function spawnPinned(
  processes: HostProcesses,
  command: string,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  try {
    return await processes.spawn({ command, ...invocation });
  } catch (error) {
    if (
      error instanceof HostRequestError && error.kind === "program_not_found"
    ) {
      log.warn("the pinned adapter does not exist", {
        context: { command, pin: BIN_ENV_VAR },
      });
      throw new PluginMethodError(
        AGENT_NOT_INSTALLED,
        `${BIN_ENV_VAR} points at ${command}, which does not exist`,
      );
    }
    throw error;
  }
}

/** Reads an env var, treating a missing read permission as an unset value. */
function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // The host may not grant --allow-env; absence is indistinguishable from "not set".
    return undefined;
  }
}
