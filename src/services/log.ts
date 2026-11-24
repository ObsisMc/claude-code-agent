import {
  createLogger,
  createStderrLogSink,
  type PluginLogger,
  type PluginLoggerDefaults,
} from "@ora-space/plugin-sdk";

/**
 * Process-wide access to the plugin's structured logger.
 *
 * The SDK owns one logger per `Plugin` instance, and that instance only exists once
 * `runAgentPlugin` has built it — later than the class fields of the plugin and the module-level
 * helpers that want to log. This module bridges the gap: until `installLogger` runs, records go
 * to stderr through the SDK's own sink and envelope, so nothing said during construction is lost
 * or lands on stdout; afterwards every record — including those from a logger a module created
 * before the install — is written through the SDK's logger, because `logger(...)` resolves its
 * parent on each call rather than binding it once.
 *
 * Targets name the component a record came from (`plugin`, `claude-client`, `acp`, ...) so a
 * filtered view of `plugin.log` can follow one of them; the host stamps identity and generation.
 */
let root: PluginLogger = createLogger(createStderrLogSink());

/** Adopts the SDK-owned logger; called once, from `runAgentPlugin`, before activation. */
export function installLogger(logger: PluginLogger): void {
  root = logger;
}

/**
 * Returns a logger whose records carry `target` and any component-wide context.
 *
 * The returned logger delegates to a child of whatever `root` is at the time of each call, so a
 * module-level `const log = logger("x")` evaluated at import time still follows the SDK logger
 * once it is installed.
 */
export function logger(
  target: string,
  context?: Record<string, unknown>,
): PluginLogger {
  const defaults: PluginLoggerDefaults = { target, context };
  let boundTo: PluginLogger | undefined;
  let bound: PluginLogger | undefined;
  const resolve = (): PluginLogger => {
    if (bound === undefined || boundTo !== root) {
      boundTo = root;
      bound = root.child(defaults);
    }
    return bound;
  };
  return {
    trace: (message, fields) => resolve().trace(message, fields),
    debug: (message, fields) => resolve().debug(message, fields),
    info: (message, fields) => resolve().info(message, fields),
    warn: (message, fields) => resolve().warn(message, fields),
    error: (message, fields) => resolve().error(message, fields),
    child: (childDefaults) => resolve().child(childDefaults),
  };
}
