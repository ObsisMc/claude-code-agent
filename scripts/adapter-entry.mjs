/**
 * The entry point compiled into this package's `claude-agent-acp` binary.
 *
 * `claude-agent-acp` is a Node program that drives a second, much larger program: the native
 * Claude Code CLI, which the Claude Agent SDK normally resolves out of its own `node_modules` as
 * a platform-specific optional dependency. That resolution cannot work inside a compiled
 * single-file binary — there is no `node_modules` to resolve against — so this module answers the
 * question the SDK would have answered, before handing control to the adapter unchanged.
 *
 * It runs as the adapter's own process, which means two constraints from the plugin apply here
 * too: stdout is the ACP channel and nothing but ACP frames may ever be written to it, and every
 * diagnostic goes to stderr.
 */
import { ADAPTER_BINARY_NAME, CLAUDE_BINARY_NAME } from "./paths.generated.mjs";
import { resolveClaudeCli } from "./resolve-claude-cli.mjs";

/** Writes one diagnostic to stderr; stdout carries ACP frames and nothing else. */
function warn(message) {
  process.stderr.write(`[${ADAPTER_BINARY_NAME}] ${message}\n`);
}

// The SDK reads this before resolving anything of its own, so setting it here is what replaces
// the `node_modules` lookup that a compiled binary cannot perform. It is set unconditionally:
// `ORA_CLAUDE_BIN` is this package's own knob, and honoring a stray `CLAUDE_CODE_EXECUTABLE` from
// the surrounding environment would silently run a different CLI than the package ships.
process.env.CLAUDE_CODE_EXECUTABLE = resolveClaudeCli({
  env: process.env,
  execPath: process.execPath,
  claudeBinaryName: CLAUDE_BINARY_NAME,
  warn,
}).path;

await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
