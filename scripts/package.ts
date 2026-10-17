/**
 * Builds one `.orax` per target, each carrying the ACP adapter and the Claude Code CLI it drives.
 *
 * Nothing here decides a version: `upstream.lock.json` records the whole chain and this script
 * reproduces it, verifying every download against the digest recorded there. What to build for
 * comes from `bundle.config.ts`, and where the binaries land inside a package comes from
 * `src/services/bundled-binary.ts`, which is also what the running plugin reads — a mismatch
 * between staging and spawning would only ever surface as an install that cannot start.
 *
 * Usage:
 *   deno task package                                  # every target, tag from orax.toml
 *   deno task package --target x86_64-pc-windows-msvc  # just one, for a local install
 *   deno task package --tag v0.73.0 --repo owner/name  # what CI runs, and what writes a manifest
 *   deno task package --tag v0.73.0 --repo owner/name --agent-configuration
 *                                                      # also bind the Agent declaration
 *
 * Produces `dist/packages/<identifier>-<tag>-<triple>.orax`, plus `dist/manifest.toml` — the
 * release form of the manifest the marketplace index needs — when a repository is named. With
 * `--agent-configuration` it also writes `dist/agent-configuration.json`, the static copy the
 * marketplace reads beside the entry; pass it only once the Ora hosts resolving an
 * `[agent_configuration]` section are deployed, because older hosts ignore the section and
 * would install the release without proving the declaration binding. The declaration bytes
 * themselves ship in every package either way: they are inert metadata until a release binds
 * them.
 */
import { parseArgs } from "@std/cli/parse-args";
import { encodeHex } from "@std/encoding";
import { basename, dirname, join, relative } from "@std/path";
import { FileEntry, Reader, ZipReader, ZipWriter } from "@zip-js/zip-js";
import bundle from "../bundle.config.ts";
import {
  downloadVerified,
  extractTarEntry,
  type PinnedPlatform,
  readLock,
  sha256File,
  type UpstreamLock,
} from "./upstream.ts";

/** Operating systems a package can be built for, as `Deno.build.os` spells them. */
export type TargetOs = typeof Deno.build.os;

/** One publishable target, under the three names the tools involved each insist on. */
export interface BundleTarget {
  /** What `Deno.build.os` calls this platform, which is what names the binaries in a package. */
  os: TargetOs;
  /** The Claude Agent SDK's platform spelling, which keys `upstream.lock.json`. */
  npm: string;
  /** What `bun build --compile --target` takes. */
  bun: string;
}

/** What a plugin declares about the CLI it bundles and the targets it publishes for. */
export interface BundleConfig {
  /** The npm package publishing the ACP adapter, and the root of the resolved chain. */
  adapter: string;
  /** Every target published, keyed by the canonical Rust triple Ora matches a package against. */
  targets: Record<string, BundleTarget>;
  /** Package-relative path the adapter is staged at, and that the plugin asks the host to spawn. */
  adapterPath: (os: TargetOs) => string;
  /** Package-relative path the CLI is staged at, and that the adapter looks for beside itself. */
  claudePath: (os: TargetOs) => string;
}

const config: BundleConfig = bundle;

const DIST = "dist";
const PACKAGES_DIR = join(DIST, "packages");
const DOWNLOAD_DIR = join(DIST, "download");
const STAGE_DIR = join(DIST, "stage");
/** Where the adapter's npm dependencies are installed so Bun can compile against them. */
const ADAPTER_DIR = join(DIST, "adapter");

/** Package-relative path of the Agent declaration every package carries. */
const DECLARATION_ENTRY = "assets/config.json";

/** The static copy's name, both as a release asset and inside a marketplace registry entry. */
const DECLARATION_COPY = "agent-configuration.json";

/** The declaration size bound the host's compiler enforces; a larger file could never install. */
const MAX_DECLARATION_BYTES = 256 * 1024;

/**
 * Smallest plausible size for each staged binary, as a guard against staging nothing at all.
 *
 * Both are hundreds of megabytes in practice. The check exists because the failure it catches is
 * silent in every other way: a package missing its CLI installs, registers, and only fails when a
 * user first opens a session, by which point nothing points back at packaging.
 */
const MINIMUM_ADAPTER_BYTES = 20_000_000;

/** One target's resolved packaging inputs. */
interface TargetPlan {
  triple: string;
  target: BundleTarget;
  claude: PinnedPlatform;
  /** Package-relative paths the two binaries are staged at. */
  adapterPath: string;
  claudePath: string;
}

/**
 * Runs one command, failing loudly rather than letting a broken package be published.
 *
 * Windows spellings are tried in turn for the same reason the plugin tries them at runtime: Deno's
 * own program lookup appends `.exe` to a bare name and does not try `.cmd`, so a Bun installed by
 * npm — which leaves exactly that shim — is invisible to a bare `bun`.
 */
async function run(command: string, ...args: string[]): Promise<string> {
  const candidates = Deno.build.os === "windows"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  for (const [index, candidate] of candidates.entries()) {
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(candidate, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound && index < candidates.length - 1
      ) {
        continue;
      }
      throw new Error(`${command} is not installed: ${describe(error)}`);
    }
    if (!output.success) {
      throw new Error(
        `${candidate} ${args.join(" ")} failed with ${output.code}: ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    return new TextDecoder().decode(output.stdout).trim();
  }
  throw new Error(`${command} is not installed`);
}

/** Renders any thrown value as a message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads one required field out of the installed manifest this repository ships. */
async function manifestField(field: string): Promise<string> {
  const source = await Deno.readTextFile("orax.toml");
  const match = source.match(new RegExp(`^${field}\\s*=\\s*"(.*)"`, "m"));
  if (match === null) {
    throw new Error(`orax.toml declares no ${field}`);
  }
  return match[1];
}

/**
 * Installs the adapter and its dependencies once, for every target to be compiled against.
 *
 * `--omit=optional` is not an optimisation: the adapter's optional dependencies are the native CLI
 * for all eight platforms, well over a gigabyte, and none of them would be used — the CLI each
 * package ships is downloaded per target below, chosen by the target rather than by the machine
 * running this script.
 */
async function prepareAdapter(lock: UpstreamLock): Promise<void> {
  await Deno.mkdir(ADAPTER_DIR, { recursive: true });
  await Deno.writeTextFile(
    join(ADAPTER_DIR, "package.json"),
    `${
      JSON.stringify(
        {
          name: "ora-claude-adapter-build",
          private: true,
          type: "module",
          dependencies: { [lock.adapter.name]: lock.adapter.version },
        },
        null,
        2,
      )
    }\n`,
  );
  await run("bun", "install", "--cwd", ADAPTER_DIR, "--omit=optional");

  // The lock is only a promise about what was requested; this is what makes it a fact about what
  // is being compiled in.
  const installed = JSON.parse(
    await Deno.readTextFile(
      join(ADAPTER_DIR, "node_modules", lock.adapter.name, "package.json"),
    ),
  ) as { version: string };
  if (installed.version !== lock.adapter.version) {
    throw new Error(
      `${lock.adapter.name} resolved to ${installed.version}, but ${LOCKED} pins ${lock.adapter.version}`,
    );
  }
}

/** Named once so the two places that blame the lock spell it the same way. */
const LOCKED = "upstream.lock.json";

/**
 * Compiles the adapter into the single-file binary this package ships.
 *
 * The entry point is generated next to the installed dependencies rather than compiled where it
 * lives, because Bun resolves imports from the entry file's own directory upwards — and it needs
 * to find `node_modules` there. The binary names it bakes in come from the same module the plugin
 * reads, through a generated file, so the path the adapter looks for its CLI at cannot drift from
 * the path this script stages one at.
 */
async function compileAdapter(plan: TargetPlan, staged: string): Promise<void> {
  await Deno.writeTextFile(
    join(ADAPTER_DIR, "paths.generated.mjs"),
    "// Generated by scripts/package.ts from src/services/bundled-binary.ts. Do not edit.\n" +
      `export const ADAPTER_BINARY_NAME = ${
        JSON.stringify(basename(plan.adapterPath))
      };\n` +
      `export const CLAUDE_BINARY_NAME = ${
        JSON.stringify(basename(plan.claudePath))
      };\n`,
  );
  await Deno.copyFile(
    join("scripts", "adapter-entry.mjs"),
    join(ADAPTER_DIR, "entry.mjs"),
  );
  await Deno.mkdir(dirname(staged), { recursive: true });
  await run(
    "bun",
    "build",
    "--compile",
    `--target=${plan.target.bun}`,
    join(ADAPTER_DIR, "entry.mjs"),
    "--outfile",
    staged,
  );
  const { size } = await Deno.stat(staged);
  if (size < MINIMUM_ADAPTER_BYTES) {
    throw new Error(
      `the compiled adapter at ${staged} is ${size} bytes, far below the size a Bun binary can be`,
    );
  }
}

/**
 * Downloads and stages the native Claude Code CLI for one target.
 *
 * Two independent digests are checked, because they prove different things: the tarball against
 * npm's integrity, which says the download is the package that was published, and the extracted
 * binary against the Claude Agent SDK's own manifest, which says it is the CLI build the adapter
 * was published against.
 */
async function stageClaude(plan: TargetPlan, staged: string): Promise<void> {
  const archive = join(DOWNLOAD_DIR, `${plan.target.npm}.tgz`);
  await downloadVerified(plan.claude.tarball, plan.claude.integrity, archive);
  await extractTarEntry(archive, `package/${plan.claude.binary}`, staged);
  await Deno.remove(archive).catch(() => {});

  const { size } = await Deno.stat(staged);
  if (size !== plan.claude.size) {
    throw new Error(
      `${staged} is ${size} bytes, but ${LOCKED} records ${plan.claude.size}`,
    );
  }
  const digest = await sha256File(staged);
  if (digest !== plan.claude.sha256) {
    throw new Error(
      `${staged} hashes to ${digest}, but ${LOCKED} records ${plan.claude.sha256}`,
    );
  }
}

/**
 * Matches every logo asset a plugin might carry: `logo.svg`, a themed variant like
 * `logo.dark.svg`, and the same two shapes for the raster formats marketplaces also accept.
 */
const LOGO_PATTERN = /^logo(\.[^./]+)?\.(svg|png|jpe?g|webp)$/i;

/** Every logo file in the plugin root, discovered by name rather than a fixed list. */
async function findLogoFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(".")) {
    if (entry.isFile && LOGO_PATTERN.test(entry.name)) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * Stages the files every package ships alongside its binaries.
 *
 * `target` is the triple the package self-declares in `[artifact]`, which is what lets Ora verify
 * after extraction that the package it downloaded is really the one built for this machine.
 * The Agent declaration is required rather than optional: this repository publishes a
 * personal-model agent, and a package quietly missing its declaration could only ever surface
 * as a release whose configuration surface behaves differently from its siblings.
 */
async function stagePluginFiles(target: string): Promise<void> {
  await Deno.mkdir(STAGE_DIR, { recursive: true });
  await Deno.copyFile(join(DIST, "main.js"), join(STAGE_DIR, "main.js"));
  for (const extra of [...await findLogoFiles(), "README.md"]) {
    await Deno.copyFile(extra, join(STAGE_DIR, extra)).catch(() => {});
  }
  await Deno.mkdir(dirname(join(STAGE_DIR, DECLARATION_ENTRY)), {
    recursive: true,
  });
  await Deno.copyFile(DECLARATION_ENTRY, join(STAGE_DIR, DECLARATION_ENTRY));
  const manifest = (await Deno.readTextFile("orax.toml")).trimEnd();
  await Deno.writeTextFile(
    join(STAGE_DIR, "orax.toml"),
    `${manifest}\n\n[artifact]\ntarget = "${target}"\n`,
  );
}

/**
 * Reads one file in place for the ZIP writer, so a package's binaries never land in memory.
 *
 * The obvious `BlobReader(new Blob([await Deno.readFile(path)]))` costs twice the file's size in
 * resident memory, and this script writes two files of a few hundred megabytes each into every
 * package it builds.
 */
class FileReader extends Reader<string> {
  #file: Deno.FsFile | undefined;
  // The base class takes the value it reads but does not expose it back to a subclass, so the
  // path is kept here too rather than reached for through the instance.
  readonly #path: string;

  constructor(path: string) {
    super(path);
    this.#path = path;
  }

  override async init(): Promise<void> {
    this.size = (await Deno.stat(this.#path)).size;
    this.#file = await Deno.open(this.#path);
  }

  /**
   * Returns only the bytes actually read, which is what ends the stream rather than an optimisation.
   *
   * The base class reads a reader by pulling fixed-size chunks with no idea of the total, so the
   * only thing that stops it is a read that comes back empty. Returning the full requested length
   * — a zero-padded buffer past the end of the file — is therefore an infinite loop that writes
   * zeroes into the archive until the disk fills, and it looks like a slow build rather than a
   * failure while it happens.
   */
  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const file = this.#file;
    if (file === undefined) throw new Error(`${this.#path} was not opened`);
    const buffer = new Uint8Array(length);
    let read = 0;
    await file.seek(index, Deno.SeekMode.Start);
    while (read < length) {
      const count = await file.read(buffer.subarray(read));
      if (count === null) break;
      read += count;
    }
    return buffer.subarray(0, read);
  }

  close(): void {
    this.#file?.close();
    this.#file = undefined;
  }
}

/**
 * Writes one staged directory tree into a `.orax`, recording the execute bit on `executables`.
 *
 * The execute bit is what makes a bundled binary spawnable after Ora extracts the package, and a
 * ZIP carries it in the upper 16 bits of the external file attributes. A fixed `0o100755` is
 * written rather than whatever upstream recorded, so a package can never install a setuid or
 * otherwise surprising mode.
 */
async function writeOrax(
  stageDir: string,
  destination: string,
  executables: ReadonlySet<string>,
): Promise<void> {
  await Deno.mkdir(dirname(destination), { recursive: true });
  const file = await Deno.create(destination);
  const writer = new ZipWriter(file.writable);
  let staged = 0;
  for await (const entry of walk(stageDir)) {
    const name = relativeSlashPath(stageDir, entry);
    staged += (await Deno.stat(entry)).size;
    const reader = new FileReader(entry);
    try {
      await writer.add(name, reader, {
        externalFileAttribute: executables.has(name)
          ? (0o100_755 << 16) >>> 0
          : (0o100_644 << 16) >>> 0,
      });
    } finally {
      reader.close();
    }
  }
  await writer.close();

  // Both binaries are already-compressed executables, so a correct package lands within a few
  // percent of what went into it. Anything larger means the archive is carrying bytes no staged
  // file supplied, which is the shape a reader that never signals its end leaves behind — and the
  // one failure here that otherwise looks like a slow build rather than a broken one.
  const written = (await Deno.stat(destination)).size;
  if (written > staged * 1.05 + 1_000_000) {
    throw new Error(
      `${destination} is ${written} bytes, well over the ${staged} bytes staged for it`,
    );
  }
}

/** Yields every ordinary file under `root`, depth first. */
async function* walk(root: string): AsyncGenerator<string> {
  for await (const item of Deno.readDir(root)) {
    const path = join(root, item.name);
    if (item.isDirectory) {
      yield* walk(path);
    } else if (item.isFile) {
      yield path;
    }
  }
}

/** Renders one path below `root` as the slash-separated name a ZIP entry carries. */
function relativeSlashPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

/**
 * Reads the declaration bytes back out of a built package.
 *
 * The release association is derived from what the archive actually carries, not from the file
 * that was staged into it: reading the entry back is what proves the copy a marketplace will
 * publish is byte-identical to the declaration every target installs. The central-directory
 * lookup makes this cheap even on packages of a few hundred megabytes.
 */
async function packagedDeclaration(
  archive: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new FileReader(archive);
  const zip = new ZipReader(reader);
  try {
    const entry = (await zip.getEntries()).find(
      (candidate): candidate is FileEntry =>
        candidate.filename === DECLARATION_ENTRY && !candidate.directory,
    );
    if (entry === undefined) {
      throw new Error(`${archive} carries no ${DECLARATION_ENTRY}`);
    }
    return new Uint8Array(await entry.arrayBuffer());
  } finally {
    await zip.close();
    reader.close();
  }
}

/** One release's verified Agent declaration, as the marketplace entry binds it. */
export interface AgentConfigurationAssociation {
  /** Declaration schema version the published copy declares. */
  schemaVersion: number;
  /** Lowercase hex SHA-256 of the exact declaration bytes every package of this release carries. */
  declarationSha256: string;
  /** Registry-entry-relative path of the static copy the marketplace sync reads. */
  copy: string;
}

/** Renders a SHA-256 digest as lowercase hex, the same spelling `upstream.ts` records. */
async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

/**
 * Builds the release association from the bytes the packages actually carry.
 *
 * The digest is over the exact bytes, so a reformatted declaration is a different release
 * identity by construction. The schema version is read from the declaration itself — the one
 * source that cannot drift from the bytes — without this script interpreting any other part of
 * the shape: whether the declaration is *legal* is proven by the host compilers at marketplace
 * sync and install, not re-invented here.
 */
export async function declarationAssociation(
  declaration: Uint8Array<ArrayBuffer>,
): Promise<AgentConfigurationAssociation> {
  if (declaration.byteLength > MAX_DECLARATION_BYTES) {
    throw new Error(
      `${DECLARATION_ENTRY} is ${declaration.byteLength} bytes, over the ` +
        `${MAX_DECLARATION_BYTES}-byte bound every host enforces`,
    );
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(declaration);
  const parsed = JSON.parse(text) as { schemaVersion?: unknown };
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof parsed.schemaVersion !== "number" ||
    !Number.isSafeInteger(parsed.schemaVersion) || parsed.schemaVersion < 1
  ) {
    throw new Error(
      `${DECLARATION_ENTRY} declares no positive integer schemaVersion`,
    );
  }
  return {
    schemaVersion: parsed.schemaVersion,
    declarationSha256: await sha256Bytes(declaration),
    copy: DECLARATION_COPY,
  };
}

/** One built package, as the release form of the manifest advertises it. */
export interface ReleaseTarget {
  /** The canonical Rust triple this package installs on. */
  triple: string;
  url: string;
  /** Lowercase hex SHA-256 of the `.orax`, which Ora checks after downloading it. */
  sha256: string;
}

/**
 * Renders the release form of the manifest, which is what a marketplace entry is copied from.
 *
 * It is the installed manifest verbatim plus one `[[targets]]` block per package, and the whole
 * file is meant to be pasted into the registry as-is. Four properties of that shape are load
 * bearing rather than cosmetic, and the host rejects a manifest that breaks any of them:
 *
 * - `[[targets]]` and a top-level `url`/`sha256` pair are **mutually exclusive** — one describes
 *   per-target packages and the other a universal one, and a manifest carrying both would leave
 *   download precedence ambiguous. This plugin ships per-target packages, so it emits only the
 *   former.
 * - A `[agent_configuration]` section, when one is given, binds the declaration digest every
 *   package of this release carries to the registry-relative copy path. It renders before the
 *   `[[targets]]` blocks, like every top-level table, and a release only carries it once the
 *   hosts resolving it are deployed — older hosts ignore the section and would install without
 *   proving the binding.
 * - The blocks come **after** every top-level key. TOML binds a bare key to the table header above
 *   it, so a field appended below `[[targets]]` would silently become part of that target rather
 *   than of the plugin.
 * - No `[artifact]` section appears here. That is the *installed* form's self-declaration of which
 *   triple a package was built for, staged into each `.orax` separately; the host refuses it in a
 *   release manifest.
 */
export function releaseManifest(
  installed: string,
  targets: readonly ReleaseTarget[],
  agentConfiguration?: AgentConfigurationAssociation,
): string {
  const blocks = targets.map((target) =>
    `[[targets]]\ntarget = "${target.triple}"\nurl = "${target.url}"\n` +
    `sha256 = "${target.sha256}"`
  );
  const association = agentConfiguration === undefined
    ? ""
    : `\n\n[agent_configuration]\nschema_version = ${agentConfiguration.schemaVersion}\n` +
      `declaration_sha256 = "${agentConfiguration.declarationSha256}"\n` +
      `copy = "${agentConfiguration.copy}"`;
  return `${[installed.trimEnd() + association, ...blocks].join("\n\n")}\n`;
}

/** Stages one target's package tree, both binaries included, and zips it into a `.orax`. */
async function buildPackage(plan: TargetPlan, fileName: string): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  await compileAdapter(plan, join(STAGE_DIR, plan.adapterPath));
  await stageClaude(plan, join(STAGE_DIR, plan.claudePath));
  await stagePluginFiles(plan.triple);
  await writeOrax(
    STAGE_DIR,
    join(PACKAGES_DIR, fileName),
    new Set([plan.adapterPath, plan.claudePath]),
  );
  await Deno.remove(STAGE_DIR, { recursive: true });
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["tag", "repo", "target"],
    boolean: ["agent-configuration"],
  });
  const version = await manifestField("version");
  const tag = flags.tag ?? Deno.env.get("GITHUB_REF_NAME") ?? `v${version}`;
  const repo = flags.repo ?? Deno.env.get("GITHUB_REPOSITORY");
  const identifier = await manifestField("identifier");

  const lock = await readLock();
  const triples = flags.target === undefined
    ? Object.keys(config.targets)
    : [flags.target];

  await Deno.mkdir(PACKAGES_DIR, { recursive: true });
  await prepareAdapter(lock);
  console.log(
    `Bundling ${lock.adapter.name}@${lock.adapter.version} with Claude Code ` +
      `${lock.agentSdk.claudeVersion}\n`,
  );

  const base = repo === undefined
    ? undefined
    : `https://github.com/${repo}/releases/download/${tag}`;
  const released: ReleaseTarget[] = [];
  // Every target must carry the same declaration bytes: the release binds one digest for all of
  // its packages, so a target whose bytes drifted is a broken release, not a variant.
  let declaration: Uint8Array<ArrayBuffer> | undefined;

  for (const triple of triples) {
    const target = config.targets[triple];
    if (target === undefined) {
      throw new Error(`bundle.config.ts declares no target ${triple}`);
    }
    const claude = lock.platforms[target.npm];
    if (claude === undefined) {
      throw new Error(`${LOCKED} records no CLI for ${target.npm}`);
    }
    const plan: TargetPlan = {
      triple,
      target,
      claude,
      adapterPath: config.adapterPath(target.os),
      claudePath: config.claudePath(target.os),
    };
    const fileName = `${identifier}-${tag}-${triple}.orax`;
    await buildPackage(plan, fileName);

    const path = join(PACKAGES_DIR, fileName);
    const packaged = await packagedDeclaration(path);
    if (declaration === undefined) {
      declaration = packaged;
    } else if (!bytesEqual(declaration, packaged)) {
      throw new Error(
        `${fileName} carries declaration bytes that differ from an earlier target; one ` +
          `release binds exactly one declaration`,
      );
    }
    const digest = await sha256File(path);
    const { size } = await Deno.stat(path);
    if (base !== undefined) {
      released.push({ triple, url: `${base}/${fileName}`, sha256: digest });
    }
    console.log(
      `packaged ${fileName} (${(size / 1_000_000).toFixed(1)} MB)`,
    );
  }
  await Deno.remove(DOWNLOAD_DIR, { recursive: true }).catch(() => {});

  // The marketplace index needs the release form of the manifest, which carries the download URLs
  // and digests. It is only knowable once the packages exist, so it is generated rather than
  // committed — and only when a repository is named, since a partial local build would otherwise
  // write a manifest advertising targets it did not build.
  if (base !== undefined && flags.target === undefined) {
    // The association is emitted only when the caller says the deployed hosts resolve it; the
    // declaration bytes themselves already ship in every package either way.
    let association: AgentConfigurationAssociation | undefined;
    if (flags["agent-configuration"]) {
      if (declaration === undefined) {
        throw new Error(
          "no packages were built; none carries a declaration to bind",
        );
      }
      association = await declarationAssociation(declaration);
      await Deno.writeFile(join(DIST, DECLARATION_COPY), declaration);
      console.log(
        `bound agent declaration ${association.declarationSha256} as ${DECLARATION_COPY}`,
      );
    }
    const path = join(DIST, "manifest.toml");
    await Deno.writeTextFile(
      path,
      releaseManifest(
        await Deno.readTextFile("orax.toml"),
        released,
        association,
      ),
    );
    console.log(`\nwrote ${path}`);
  }
}

/** Compares two byte sequences; `Uint8Array` has no equality of its own. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

if (import.meta.main) {
  await main();
}
