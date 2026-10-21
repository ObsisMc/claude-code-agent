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
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { ADAPTER_BINARY_NAME, CLAUDE_BINARY_NAME } from "./paths.generated.mjs";

/** Pins one exact Claude Code CLI, outranking both the bundled copy and any local install. */
const BIN_ENV_VAR = "ORA_CLAUDE_BIN";

/**
 * Set by the plugin for a platform-model execution: only the bundled CLI may run, never a pin or
 * a local install. The route the plugin applied was tested against this exact pair, and another
 * CLI build could read provider settings differently.
 */
const BUNDLED_ONLY_ENV_VAR = "ORA_CLAUDE_BUNDLED_CLI_ONLY";

/**
 * Resolves the Claude Code CLI this adapter should drive, preferring the one shipped beside it.
 *
 * The bundled CLI comes first because it is the build the adapter was published against: the
 * adapter's own `package.json` pins an exact Claude Agent SDK version, and that SDK names one
 * exact CLI build, so the pair in this package is the pair upstream tested. A local install is a
 * fallback for the cases where the bundled one cannot run at all, and it is deliberately not
 * preferred over the bundled one even when it is newer — the bridge between adapter and CLI is an
 * internal interface, and an unpaired combination fails in ways that only reproduce on the
 * machine that has it.
 */
function resolveClaudeCli() {
  // `process.execPath` is this compiled binary's own absolute path, whatever the working
  // directory is, which is the only way to find the package this binary was installed into: a
  // plugin is told no host path, and the package-relative paths the host understands are not
  // resolvable from inside a process it spawned.
  const bundled = join(dirname(process.execPath), CLAUDE_BINARY_NAME);
  if (process.env[BUNDLED_ONLY_ENV_VAR] === "1") {
    if (!isExecutableFile(bundled) || isUnrunnableHere(bundled)) {
      throw new Error(
        `${BUNDLED_ONLY_ENV_VAR} requires the bundled Claude Code CLI at ${bundled}, which cannot run here`,
      );
    }
    return { path: bundled, source: "bundled" };
  }

  const pinned = process.env[BIN_ENV_VAR]?.trim();
  if (pinned) {
    if (!isExecutableFile(pinned)) {
      throw new Error(
        `${BIN_ENV_VAR} points at ${pinned}, which does not exist`,
      );
    }
    return { path: pinned, source: "pinned" };
  }

  if (isExecutableFile(bundled) && !isUnrunnableHere(bundled)) {
    return { path: bundled, source: "bundled" };
  }

  const local = findLocalClaude();
  if (local) {
    return { path: local, source: "local" };
  }

  throw new Error(
    `no Claude Code CLI to run: this package ships none at ${bundled}, none was found on PATH, ` +
      `and ${BIN_ENV_VAR} is not set`,
  );
}

/**
 * Reports whether the bundled CLI is one this machine cannot execute despite it being present.
 *
 * Only Linux can get here. Packages are built per target triple and Ora refuses to install one
 * built for another, so on Windows and macOS a bundled binary that exists also runs. Linux is the
 * exception because libc is not part of the triple: the `-gnu` build this package ships is a
 * dynamically linked binary whose loader (`/lib/ld-musl-*` vs `/lib64/ld-linux-*`) does not exist
 * on a musl system, so it fails at exec time with an error that says nothing about libc. Checking
 * up front turns that into a fallback rather than a crash.
 */
function isUnrunnableHere(bundled) {
  if (process.platform !== "linux") return false;
  const loader = process.arch === "arm64"
    ? "/lib/ld-musl-aarch64.so.1"
    : "/lib/ld-musl-x86_64.so.1";
  if (!existsSync(loader)) return false;
  warn(
    `the bundled Claude Code CLI at ${bundled} is a glibc build and this system uses musl; ` +
      `looking for a local install instead`,
  );
  return true;
}

/**
 * Finds a Claude Code CLI the user installed themselves.
 *
 * Every spelling a real installer produces is tried, not just the bare name: the native installer
 * writes `claude`/`claude.exe`, while npm and bun leave a `.cmd`/`.bat` shim on Windows. Omitting
 * one is indistinguishable from "not installed" and fails far from its cause. `.exe` is tried
 * first, following Windows' own `PATHEXT` precedence, so what gets spawned is the CLI itself
 * rather than a shell wrapper around it.
 */
function findLocalClaude() {
  const names = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  // The native installer's location is searched too: it is not always on the PATH of a process
  // spawned by a desktop application, which inherits a login environment rather than a shell one.
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
  ];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate)) {
        warn(
          `using the Claude Code CLI found at ${candidate}; it is not the build this adapter ` +
            `was published with, so report any protocol failure with both versions`,
        );
        return candidate;
      }
    }
  }
  return undefined;
}

/** Reports whether a path names a regular file, the only thing worth trying to spawn. */
function isExecutableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Writes one diagnostic to stderr; stdout carries ACP frames and nothing else. */
function warn(message) {
  process.stderr.write(`[${ADAPTER_BINARY_NAME}] ${message}\n`);
}

// The SDK reads this before resolving anything of its own, so setting it here is what replaces
// the `node_modules` lookup that a compiled binary cannot perform. It is set unconditionally:
// `ORA_CLAUDE_BIN` is this package's own knob, and honoring a stray `CLAUDE_CODE_EXECUTABLE` from
// the surrounding environment would silently run a different CLI than the package ships.
process.env.CLAUDE_CODE_EXECUTABLE = resolveClaudeCli().path;

await import("@agentclientprotocol/claude-agent-acp/dist/index.js");
