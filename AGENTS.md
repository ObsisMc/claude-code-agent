# ora-space.claude

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `claude-agent-acp` to Ora as an ACP pipe.
`README.md` describes what it does; this file records the constraints that are
easy to get wrong and expensive to rediscover. It follows the same shape as the
sibling `codeagent-agent/AGENTS.md` and `opencode-agent/AGENTS.md` — this
package used to lag them on an older SDK pin (`0.3.0`, no `HostProcesses`,
`waitForIdle`/`restart` Effect Surfaces, camelCase `agent/listModels`) until it
was migrated onto `0.9.0` to match and now tracks `0.10.0`; see the root
`../AGENTS.md` for the general rule this migration exists to satisfy.

## This is an agent plugin, and an agent plugin implements the whole SDK contract

**`kind = "agent"` in `orax.toml` is not a label — it is a contract, and a
partial implementation of it fails silently rather than loudly.** Ora validates
the registration handshake and then simply does not use what a plugin did not
declare. There is no warning, no log line, and no error surfaced to the user.

Every API the plugin SDK offers an agent must be served, not just the ones a
feature currently exercises:

| SDK surface                                                                                                                             | Where it is mounted                                     | What is lost by omitting it                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent/start` · `agent/stop`                                                                                                            | `handlers/lifecycle.ts`                                 | the agent cannot run at all — these are `abstract`, so this fails to compile |
| `agent/list_models`                                                                                                                     | `handlers/models.ts`                                    | no model picker; also `abstract`                                             |
| `agent/acp` (both directions)                                                                                                           | `handlers/acp.ts` + `services/claude-client.ts`         | no conversation; also `abstract`                                             |
| **Effect Resources** — `effect/coordinate`, `effect/reactivate`, `effect/verify_ready`, and the `EffectResourceDeclaration` behind them | `handlers/effects.ts`, mounted as `AgentPlugin.effects` | **Skills never appear in the Workspace, with no error anywhere**             |

The Effect row is the one that has actually shipped broken before, in the
sibling `codeagent-agent`. Read the next section before touching anything about
Skills.

## Effects are opt-in, and opting out is invisible

The Skill directory Ora writes into a Workspace exists **only** because this
plugin declares it. The chain is short and every link is a hard gate:

```
handlers/effects.ts  SKILLS_RESOURCE                    ← the declaration
main.ts              override readonly effects = …      ← mounted on the instance
base/agent-plugin.ts defineAgent({ …, effects })        ← handed to the SDK
SDK agent.ts         if (effects !== undefined) { declareEffectResource(…) }
SDK plugin.ts        effectResources omitted from ora/register when the list is empty
```

Miss **any** of those and `ora/register` goes out with no `effectResources`
field at all. From Ora's side this plugin does not consume Skills, so importing
one succeeds, Ora has no Target to project it onto, nothing is written to disk,
and no error is raised, logged, or shown anywhere.

**When a Skill does not appear, check the declaration before debugging
materialization.** The shipped bundle answers it in one command:

```
deno task build && grep -c skill dist/main.js
```

A `0` means the declaration never reached the package.

### What the coordination calls have to promise

Declaring a Resource is also a promise to make its mutation safe, and Ora will
call all three methods:

- **`coordinate`** must raise the new-turn barrier _before_ it waits for running
  turns, not after. A check that only latched on an observed idle moment would
  never find one in a Workspace whose prompts keep arriving; holding first makes
  the set of turns to drain finite, so the wait terminates. It must also release
  the barrier before failing — Ora only reactivates Targets whose coordination
  succeeded, so an abandoned barrier holds its queued prompts for the life of
  the process. The 10-second drain budget exists because Ora allows a plugin
  control call 30 seconds and coordination holds that call open; it must finish
  well inside that rather than wait out a prompt that may legitimately run for
  minutes.
- **`reactivate`** respawns the adapter. Restarting is deliberately chosen over
  modelling when Claude Code rereads its Skill directory: a restart is correct
  whether the adapter resolves Skills once at process start or per session.
- **`verify_ready`** reports readiness by **returning**; a Consumer says "not
  ready" by throwing. Returning a payload that says "not ready" would be
  recorded as ready.
- **Both coordination calls must be idempotent.** Ora retries them. The held
  frame queue is the marker: a repeat `reactivate` finds nothing held — the
  state a finished reactivation leaves behind — and must not restart an adapter
  that already rescanned, which would tear down the sessions that came back from
  the first restart.

`SKILLS_RESOURCE.workspaceRelativePath` is `.claude/skills` — the
project-relative directory Claude Code reads. Claude Code also reads a
user-level `~/.claude/skills` directory, and declaring that would be a mistake:
Ora fully owns what it materializes into a declared Resource, so it would
reconcile away Skills another tool put there.

## What a package ships, and the two binaries in it

A release carries **one `.orax` per target triple**, and each one bundles both
halves of the agent:

```
assets/bin/claude-agent-acp[.exe]   the ACP adapter, compiled to a single file by Bun
assets/bin/claude[.exe]             the native Claude Code CLI the adapter drives
main.js                             this plugin
orax.toml                           with [artifact] target = "<triple>"
```

The CLI is bundled rather than resolved from the user's machine because
**`claude-agent-acp` and the CLI are a pair upstream publishes together**: the
adapter pins an exact `@anthropic-ai/claude-agent-sdk` version, and that SDK
ships a `manifest.json` naming the exact CLI build it was published against, per
platform, with a SHA-256. The bridge between the two is an Anthropic-internal
interface, so an unpaired combination fails in ways that only reproduce on the
machine that has it. Bundling both is what makes a package's behaviour a
property of the package rather than of the machine — and it is also what gives
Ora a download to show progress for.

`src/services/bundled-binary.ts` is the only place those paths are written down.
Three things have to agree on them — `command.ts` (what the host is asked to
spawn), `scripts/adapter-entry.mjs` (where the adapter looks for its CLI), and
`scripts/package.ts` (where both are staged) — and a disagreement surfaces only
as an install that cannot start.

### Why the adapter needs a generated entry point at all

The published adapter is a Node program that finds its CLI with
`createRequire(...).resolve("@anthropic-ai/claude-agent-sdk-<platform>/claude")`
— a `node_modules` lookup that cannot work inside a compiled single-file binary.
`scripts/adapter-entry.mjs` answers that question before handing control to the
adapter unchanged, by setting `CLAUDE_CODE_EXECUTABLE` from its own ladder:

1. **`ORA_CLAUDE_BIN`** — pins one exact CLI, and fails if it points at nothing.
2. **the bundled CLI beside it**, found through `process.execPath`, which is the
   only way to locate the installed package from inside a process the host
   spawned.
3. **a local install** — every Windows spelling, then `~/.local/bin`, with a
   warning to stderr, because at that point the pair is no longer the tested
   one.

`CLAUDE_CODE_EXECUTABLE` from the surrounding environment is deliberately
**not** honoured: it is upstream's variable, not this package's, and a stray one
would silently run a different CLI than the package ships. `ORA_CLAUDE_BIN` is
the knob.

Step 3 is not just insurance. Packages are built per triple, so on Windows and
macOS a bundled binary that exists also runs — but libc is not part of a triple,
and the `-gnu` build this package ships cannot exec on a musl system at all.
That case is detected up front (`/lib/ld-musl-*`) so it becomes a fallback
rather than a crash that says nothing about libc.

Everything that entry point writes goes to **stderr**: it runs as the adapter's
own process, so its stdout is the ACP channel — the same rule as the plugin's,
one process further down.

## The release pipeline

Two commands, deliberately separate:

```
deno task sync      # resolve upstream, write upstream.lock.json
deno task package   # reproduce exactly what the lock records
```

`upstream.lock.json` records the whole chain — adapter version, SDK version,
Claude Code version, and per-platform tarball integrity plus the CLI's own size
and SHA-256. **Packaging resolves nothing by name**, so rebuilding a tag
produces the same bytes and a version bump arrives as a reviewable diff rather
than as whatever npm answered that day. `deno task sync --check` exits `20` when
the lock is behind, which is what a scheduled job branches on.

Two independent digests are verified per target, and they prove different
things: the tarball against npm's `dist.integrity` (this is the package that was
published) and the extracted CLI against the SDK manifest's checksum (this is
the build the adapter was published against).

`--target <triple>` builds one package, which is what to use locally — a full
run downloads a few hundred megabytes per platform.

### Versioning, and the two ways a release starts

**This plugin's version is its own.** It deliberately does not mirror the
adapter's, which moves for reasons that have nothing to do with this package —
what a user has installed should say which version of _this_ plugin they are
running, and `upstream.lock.json` in that release says which upstream pair it
carries.

Two paths produce a release, and both end in the same `release.yml`:

| Trigger                               | Version                         | Who bumps it                                |
| ------------------------------------- | ------------------------------- | ------------------------------------------- |
| a new `claude-agent-acp` (daily cron) | patch `z` + 1                   | `upstream.yml` commits the bump and the tag |
| a change to the plugin itself         | whatever the maintainer chooses | the maintainer, in the commit they tag      |

`release.yml` **fails if the tag and `orax.toml` `version` disagree**, because
Ora installs a package under the version inside it rather than the one in the
release title — so a mismatch publishes an artifact that installs as something
else. Bump `orax.toml` _and_ `deno.json`, then tag that commit.

`upstream.yml` calls `release.yml` through `workflow_call` rather than pushing a
tag and letting the tag trigger it. That is not a style choice: **a tag pushed
with the built-in `GITHUB_TOKEN` does not start another workflow run**, so the
tag-and-hope design would tag every upstream bump and publish none of them.

### Publishing to the marketplace

A release is not installable until `registry/o/ora-space.claude/orax.toml` in
`ora-space/marketplace` points at it. `release.yml` calls `marketplace.yml` as a
reusable workflow the moment its own release job succeeds — a direct
`workflow_call`, not the `release` event, because `gh release create` runs under
this repository's own `GITHUB_TOKEN`, and GitHub does not fire `release` events
for another workflow to catch when the actor is the token of the same run.
`marketplace.yml` also runs on `workflow_dispatch` for the latest release or a
specific tag, which is how to pick up an entry that drifted behind for any other
reason. Either way it copies the release's `manifest.toml` in verbatim as the
registry entry, along with `README.md` and every logo asset the plugin carries
(`logo.svg`, any themed variant such as `logo.dark.svg`, and any raster format).
It never merges anything.

Keeping publishing a separate workflow from releasing is deliberate: nothing
here merges the PR, so **a merged marketplace PR, not a green `release.yml` or
an opened marketplace PR, is what users can actually install** — a release
nobody has reviewed into the marketplace yet looks identical to a published one
from this repository's own state.

The branch is one per plugin (`release/ora-space.claude`) and force-pushed, not
one per tag: branching per tag would stack up an open PR per release the moment
two releases in a row produced one, all editing the same file. An unmerged PR is
retargeted at the newer release instead. The push needs the organization's
`MARKETPLACE_SYNC_APP_ID` / `MARKETPLACE_SYNC_APP_PRIVATE_KEY` app credentials,
because `GITHUB_TOKEN` is scoped to this repository and cannot write to the
marketplace.

Those credentials are shared with selected repositories only, so a repository
can simply be off that list. The workflow checks for them up front and stops
with a run summary naming what is missing, rather than reaching
`create-github-app-token` and failing on an opaque token error on every run —
the same distinction the plugin itself draws between expected configuration and
a real failure. **A run that says "Not published" is that check, not a bug.**

### The Agent declaration, and when a release binds it

Every package ships `assets/config.json`, the Agent declaration of what this
plugin asks the host to configure — for now, one personal model connection over
`anthropic-messages`. Packaging stages it into each `.orax`, then **reads it
back from the finished archive**: every target of one release must carry
byte-identical declaration bytes, because the release binds exactly one
declaration digest, and a reformat is a different declaration identity however
semantically identical it looks. `tests/main_test.ts` pins that digest, so
reformatting the file is a conscious, release-affecting change — not something
formatting can do silently.

The declaration is inert until a release binds it.
`deno task package
--agent-configuration` writes the static copy
(`dist/agent-configuration.json`, attached to the release and copied into the
registry entry beside `orax.toml`) and the `[agent_configuration]` section into
`manifest.toml`; without the flag, packages still carry the bytes and nothing
else claims them.

**The flag exists because publish order is constrained by host support.** Older
Ora hosts ignore a section they do not know and would install the release
without proving the declaration binding — deterministic, but not the check the
section exists to provide. `release.yml` passes the flag only once the hosts
resolving `[agent_configuration]` are deployed; that is an owner decision made
by editing one line, not something this repository can detect.

The packaging script deliberately does not interpret the declaration's shape: it
checks readable UTF-8, the 256 KiB size bound every host enforces, and reads
`schemaVersion` — the one number the section needs — from the bytes themselves.
Whether the declaration is _legal_ is proven by the host compilers at
marketplace sync and at install, from the same shared cross-language samples;
re-implementing that judgment here would only ever drift from it.

### One packaging trap worth knowing

zip.js reads a custom `Reader` by pulling fixed-size chunks with **no idea of
the total**: the only thing that ends the stream is a read that returns an empty
array. A `readUint8Array` that returns the full requested length — a zero-padded
buffer past end of file — never terminates, and quietly writes zeroes into the
archive until the disk fills. It looks like a slow build, not a failure. Hence
`FileReader.readUint8Array` returns `buffer.subarray(0, read)`, and `writeOrax`
asserts the finished package is not meaningfully larger than the bytes staged
for it.

## Resolving the adapter on Windows — always include `.bat`

**Every list of PATH spellings for the adapter must name `.exe`, `.cmd`, `.bat`,
and the bare name.** This has broken real installs more than once, always the
same way, and it is the single most important rule in this file after the one
above.

```ts
return Deno.build.os === "windows"
  ? [
    `${BINARY_NAME}.exe`,
    `${BINARY_NAME}.cmd`,
    `${BINARY_NAME}.bat`,
    BINARY_NAME,
  ]
  : [BINARY_NAME];
```

Why each part matters:

- **The host's PATH lookup only appends `.exe` to a bare name.** It does not try
  `.cmd` or `.bat`. So naming just `claude-agent-acp` finds nothing on a machine
  where the adapter is installed as a shim — which is what `npm i -g` actually
  writes on Windows.
- **Omitting a spelling is indistinguishable from "not installed".** The ladder
  inside `spawnAgentProcess` only advances on `program_not_found`, so a missing
  spelling exhausts the list and raises `AGENT_NOT_INSTALLED` (`-32001`).
- **That failure surfaces as something unrelated.** Ora deliberately suppresses
  the log for `AgentNotInstalled` (`connection.rs`, "would flood the runtime
  log"), then tears the plugin process down — so the only thing the user sees is
  `plugin stdout closed` from the plugin runtime's stdout reader. Nothing in
  that message mentions PATH, the adapter, or the spelling that was missed. **Do
  not spend time debugging the plugin when you see `plugin stdout closed`; check
  the candidate list first.**
- **The order here is Windows' own `PATHEXT` precedence.** `.exe` first means
  the process the host holds is the adapter itself rather than a `cmd.exe`
  wrapper around it, which matters when the host kills it.

Adding a spelling is free: only "this one is not on PATH" advances to the next
candidate, and a candidate that resolved and then failed is raised as-is rather
than being buried under the next attempt.

`ORA_CLAUDE_ACP_BIN` outranks the whole ladder and is used alone, never with a
fallback: silently running a different adapter than the one a developer named is
worse than failing. It pins the **adapter** only — the CLI the adapter then
drives is pinned separately with `ORA_CLAUDE_BIN`, which is read one process
further down, in `scripts/adapter-entry.mjs`.

Since packages bundle an adapter, this PATH ladder is reached only when the host
reports the package carries none. `spawnAgentProcess` is given both
(`packageCommand` and `command`) and advances **only** on
`package_command_missing`: a bundled adapter that is present but cannot run is a
property of the package, not of this machine, so it raises `AGENT_UNUSABLE`
rather than quietly running some other adapter. Do not relabel that as
`AGENT_NOT_INSTALLED` — it would be retried forever.

## Process ownership

Every subprocess goes through the host: `createHostProcesses(plugin)` →
`ora/childprocess/spawn`. Never `Deno.Command`. The host owns the OS handle,
terminates process trees, and reclaims whatever a plugin generation left behind
— none of which a sandboxed plugin can promise, least of all through a Windows
shim whose real child outlives a kill of the wrapper.

`ClaudeClient` tracks generations: a process that is no longer `#running` was
superseded by a later `start()` — an Effect restart, typically — so its exit
must never clear the new process's tracking or fire `onExited`. The shared
`#expectedExit` flag reflects the newer generation's intent by then, which is
why the identity check comes first.

## Model discovery

`claude-agent-acp` is a pure ACP server: it takes no subcommand, and its
`initialize` result carries capabilities only. The model set appears exactly
once, as the `category: "model"` entry of the `configOptions` array in a
`session/new` result — `default`, `sonnet`, `opus`, `haiku`, `fable` as of this
writing.

`agent/list_models` receives the workspace `cwd` and answers it by running a
**separate, one-shot** `claude-agent-acp`, not by borrowing the connection Ora
holds:

- A request injected into Ora's connection returns its answer down Ora's pipe.
- Ora's own `initialize` declares the client capability that decides whether the
  adapter reports a model selector at all, and discovery runs before that.

The probe declares `clientCapabilities: { session: { configOptions: {} } }` —
without it the adapter reports no model selector. Answers are cached per
workspace for five minutes; a failure is never cached.

`session/delete` is sent only when `initialize` advertised the capability —
sending it unconditionally would earn a `method_not_found` on every discovery
and clean up nothing.

Note that `onStart` and `onStop` both invalidate the catalog for their `cwd`, so
a start/stop cycle around a picker opening makes the next open pay full price.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` routes
  every `console` method through the plugin logger before any plugin code runs.
  A single `console.log` reaching stdout is read by the host as a corrupt frame
  and takes the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the adapter's NDJSON and otherwise passed through
  verbatim — this is also what lets Claude Code's ACP extensions (session modes,
  steering, its `_meta` capabilities) reach Ora without this plugin knowing they
  exist. `handlers/effects.ts` is the one exception, and a deliberately narrow
  one: it reads `method` and `id` off the envelope to track turns, and never
  looks at `params`.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried; `-32000` is how an Effect Consumer says "not
  ready right now".

## Logging

Everything this plugin says goes through the SDK's `plugin.logger`, which writes
`@ora/plugin-log/v1` envelopes to stderr; the host persists them into this
plugin's own log file, filtered by the per-plugin level the user picks in Ora's
developer settings. `src/services/log.ts` is the one seam: `logger(target)`
returns a child logger for a component, and `installLogger` adopts the SDK-owned
instance the moment `runAgentPlugin` has built it, so records written during
construction still reach stderr in the same format rather than stdout.

Targets are how a `plugin.log` is read: `plugin` (activation, start/stop,
deactivation), `host-call` (every `agent/*` method with duration and outcome),
`lifecycle`, `acp` (frame envelopes only — `method` and `id`, never `params`),
`claude-client` (spawn, pid, exit, pipe failures), `claude-agent-acp` (the live
adapter's own stderr, one record per line at `info`), `effects` (barrier, drain,
restart, readiness), `models` and `acp-probe` (discovery; the probe adapter's
stderr is `claude-agent-acp.probe` at `debug`), and `command` (which adapter was
resolved and how). ACP payloads are never logged: a `session/prompt` carries the
user's text, and the log has no business keeping it.

## Manifest

`orax.toml` is the manifest Ora reads. `package.json` is a legacy Ora manifest
that no release has ever read, and its `engines.ora` field held a plugin **SDK**
version in a **host** version field — do not fill it with an SDK number. If a
host requirement ever needs declaring, it goes in `orax.toml`:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table today but does not yet enforce it.

## Working on this repository

- `deno task check` / `lint` / `format` / `test` / `simulate` / `build`, plus
  `sync` and `package` for releases. Packaging needs `bun` on PATH (it compiles
  the adapter) and network access to the npm registry; nothing else.
- The SDK is imported from its published JSR package and pinned in `deno.json`;
  keep `deno.lock` synchronized when changing the SDK version — see the root
  `../AGENTS.md` before bumping it, since the Effect API and process-ownership
  API have changed shape across versions before.
- `deno task test` needs no CLI: discovery is exercised against a fake
  `HostProcesses` that scripts an ACP peer, and effect coordination against a
  `ClaudeClient` with a scripted `spawn`. `deno task simulate` needs a real
  `claude-agent-acp` on PATH (`npm i -g @agentclientprotocol/claude-agent-acp`).
- One test reads `src/main.ts` as text to assert the effect wiring is present.
  That is deliberate: the entrypoint calls `runAgentPlugin` at module scope, so
  importing it would start serving the host, and the wiring it guards is exactly
  the kind whose absence is invisible at runtime.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running. Keep
  `deno.json` in step with it — `release.yml` checks `orax.toml` against the
  tag, but nothing checks the two files against each other.
