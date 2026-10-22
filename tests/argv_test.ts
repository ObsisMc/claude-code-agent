/**
 * Runs the pinned `claude-agent-acp` and Claude Code CLI on a platform route and reads what every
 * process they started shows to the rest of the machine.
 *
 * The rest of the suite proves what this plugin hands the adapter; only the real pair can show what
 * the adapter and the Claude Agent SDK then put on a command line, which anyone who can list
 * processes reads. A new pin that moves the token there again fails here.
 *
 * It needs the pair this package ships, installed from npm at the versions `upstream.lock.json`
 * names, plus Node to run the adapter, so it is its own task (`deno task test:argv`) and CI job:
 *
 * - `ORA_CLAUDE_ARGV_ADAPTER`: the adapter's `dist/index.js`.
 * - `ORA_CLAUDE_ARGV_CLI`: the platform package's `claude` binary.
 *
 * Without both it is skipped, and on anything but Linux, whose `/proc` is what it reads.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { AgentModelContext, JsonValue } from "@ora-space/plugin-sdk";
import { startClaude } from "../src/handlers/lifecycle.ts";
import {
  ClaudeClient,
  type SpawnedProcess,
} from "../src/services/claude-client.ts";

const ADAPTER = readEnv("ORA_CLAUDE_ARGV_ADAPTER");
const CLI = readEnv("ORA_CLAUDE_ARGV_CLI");
const BASE_URL = "https://gateway.invalid/runtime/anthropic";

Deno.test({
  name: "the pinned adapter and CLI never put the token on a command line",
  ignore: ADAPTER === undefined || CLI === undefined ||
    Deno.build.os !== "linux",
  async fn() {
    const token = `argv-check-${crypto.randomUUID()}`;
    const root = await Deno.makeTempDir();
    const cwd = join(root, "workspace");
    await Deno.mkdir(cwd);
    const frames: JsonValue[] = [];
    const children: Deno.ChildProcess[] = [];
    const client = new ClaudeClient({
      spawn: (spawnCwd, env) => {
        const child = new Deno.Command("node", {
          args: [ADAPTER!],
          cwd: spawnCwd,
          clearEnv: true,
          env: {
            PATH: Deno.env.get("PATH") ?? "",
            HOME: join(root, "home"),
            // What `scripts/adapter-entry.mjs` does inside the compiled adapter.
            CLAUDE_CODE_EXECUTABLE: CLI!,
            ...env,
          },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        children.push(child);
        return processOf(child);
      },
      onAcpFrame: (frame) => frames.push(frame),
    });
    try {
      await startClaude(client, {
        cwd,
        hostVersion: "1.0.0",
        modelContext: context(token),
      });
      await client.writeAcp({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      });
      await client.writeAcp({
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd, mcpServers: [] },
      });
      await waitFor(() => frames.some((frame) => isAnswer(frame, 2)), 60_000);
      assert(
        frames.some((frame) => isAnswer(frame, 2) && "result" in frame),
        "session/new failed",
      );

      const adapterPid = children[0].pid;
      let tree: ProcessView[] = [];
      await waitFor(() => {
        tree = processTree(adapterPid);
        return tree.some((process) => process.argv[0] === CLI);
      }, 30_000);
      const cli = tree.find((process) => process.argv[0] === CLI)!;

      for (const process of tree) {
        assertEquals(
          process.argv.some((arg) => arg.includes(token)),
          false,
          `the token is on the command line of ${process.argv[0]}`,
        );
      }
      // The route did reach the CLI: the token through its environment, the routing through the
      // flag settings on its command line.
      assertEquals(
        cli.environ.includes(`ANTHROPIC_CUSTOM_HEADERS=x-api-key: ${token}`),
        true,
      );
      const settings = JSON.parse(
        cli.argv[cli.argv.indexOf("--settings") + 1],
      ) as { apiKeyHelper: string; env: Record<string, string> };
      assertEquals(settings.apiKeyHelper, "");
      assertEquals(settings.env.ANTHROPIC_BASE_URL, BASE_URL);
    } finally {
      await client.stop();
      await Promise.all(children.map((child) => child.status));
      await removeEventually(root);
    }
  },
});

/** What one process shows: its arguments, and its environment as its own identity reads it. */
interface ProcessView {
  readonly argv: string[];
  readonly environ: string[];
}

/** The adapter and every process below it, read from `/proc`. */
function processTree(root: number): ProcessView[] {
  const parents = new Map<number, number>();
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`);
      // The command name in parentheses may hold spaces; the parent pid is the second field
      // after it.
      const parent = Number(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
      );
      parents.set(Number(entry.name), parent);
    } catch {
      // The process exited while the table was read.
    }
  }
  const members = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (members.has(parent) && !members.has(pid)) {
        members.add(pid);
        grew = true;
      }
    }
  }
  const views: ProcessView[] = [];
  for (const pid of members) {
    try {
      views.push({
        argv: nulSeparated(`/proc/${pid}/cmdline`),
        environ: nulSeparated(`/proc/${pid}/environ`),
      });
    } catch {
      // Gone already.
    }
  }
  return views;
}

/**
 * Removes the test's directory once the CLI, which outlives the adapter by a moment, has stopped
 * writing into it. A failure to clean up must not hide the assertion that failed.
 */
async function removeEventually(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function nulSeparated(path: string): string[] {
  return Deno.readTextFileSync(path).split("\0").filter((part) => part !== "");
}

function context(token: string): AgentModelContext {
  return {
    configuration: {
      pluginId: "official/ora-space.claude",
      pluginVersion: "0.4.0",
      target: Deno.build.target,
      packageSha256: "a".repeat(64),
      schemaVersion: 2,
      declarationFingerprint: "b".repeat(64),
      adapterVersion: 1,
      configurationRevision: 1,
      settingsJson: "{}",
      protocol: "anthropic-messages",
      model: {
        id: "claude-haiku-5-5",
        name: "Claude Haiku",
        contextWindow: 200_000,
        maxTokens: 8192,
      },
    },
    proxyBaseUrl: `${BASE_URL}/v1`,
    token,
  };
}

function processOf(child: Deno.ChildProcess): SpawnedProcess {
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    },
    exited: child.status.then(() => undefined),
  };
}

function isAnswer(
  frame: JsonValue,
  id: number,
): frame is { [key: string]: JsonValue } {
  return typeof frame === "object" && frame !== null &&
    !Array.isArray(frame) && frame.id === id && !("method" in frame);
}

function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was never met");
}
