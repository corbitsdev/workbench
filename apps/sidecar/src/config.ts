// The one boundary that reads the process environment. Everything the
// host needs from the outside world is an irreducible process fact:
// where to keep durable state, where the hub is, who this sidecar is to
// that hub, and the OS facts a spawned workflow-process child cannot
// function without. Anything else the host learns is data it is told
// over the wire, never configuration.

import { type } from "arktype";

import { parseToolRegistries } from "./tool-materialization";

const WsURL = type("string").narrow((url, ctx) => {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    return ctx.mustBe("a ws:// or wss:// URL");
  }
  if (!URL.canParse(url)) {
    return ctx.mustBe("a parseable ws:// or wss:// URL");
  }
  return true;
});

const SidecarEnv = type({
  SIDECAR_DATA_DIR: type("string > 0").describe("a non-empty filesystem path"),
  HUB_WS_URL: WsURL,
  SIDECAR_ID: type("string > 0").describe("a non-empty sidecar identifier"),
  SIDECAR_TOKEN: type("string > 0").describe("a non-empty hub-issued token"),
  // OS facts forwarded into each workflow-process child's fresh spawn
  // env (nothing else is inherited): PATH so the child's `bun` shebang
  // resolves, HOME/TMPDIR so agent code finds a writable home and the
  // same temp root the host uses.
  PATH: type("string > 0").describe("the executable search path"),
  "HOME?": "string",
  "TMPDIR?": "string",
  // Optional JSON array of tool-package registries,
  // `[{"name":"...","url":"...","auth?":{...}}]`. Unset means the
  // public npmjs registry. The value is validated here so a malformed
  // registry pin kills the boot, and threaded into every
  // workflow-process child's spawn env so per-step tool
  // materialization resolves the exact registries the operator pinned.
  "SIDECAR_TOOL_REGISTRIES?": "string",
  // Operator overrides for two workflow-supervisor timing bindings,
  // threaded verbatim to every deployment's supervisor
  // (`createSidecarWorkflowSupervisor`'s `consumedRetentionMs` /
  // `readyTimeoutMs`). Unset leaves each supervisor on the vendor's own
  // default (`DEFAULT_CONSUMED_RETENTION_MS` / `DEFAULT_READY_TIMEOUT_MS`).
  // Validated as positive-finite-number strings, matching the
  // `SIDECAR_CACHE_MAX_BYTES`-style numeric env keys.
  "CONSUMED_RETENTION_MS?": "string",
  "CHILD_READY_TIMEOUT_MS?": "string",
  // CL-5477: how long a deployment's workflow-child may sit with no
  // activity (inbound mail, signals, drains, source rotations, credential
  // updates, inference events) before the deploy router parks it -- tears
  // the child process down while keeping the persisted deployment record,
  // slug claim, and step state, so the next inbound message respawns it
  // through the same path a boot-time restore uses. Unlike
  // `CONSUMED_RETENTION_MS`/`CHILD_READY_TIMEOUT_MS`, an unset value does
  // NOT fall back to "no override" -- it applies `DEFAULT_CHILD_IDLE_REAP_MS`
  // (30 minutes), because reaping is meant to be on by default here: an
  // un-reaped idle fleet is exactly what forced the emergency
  // `CHAT_IDLE_SLEEP_MS` bump on the hub side (see commit 8ca85543). Set to
  // `0` to disable reaping entirely.
  "WORKBENCH_CHILD_IDLE_REAP_MS?": "string",
});

/**
 * Production default for `WORKBENCH_CHILD_IDLE_REAP_MS`: 30 minutes.
 * Reaping is on unless an operator explicitly sets the env var to `0`.
 */
export const DEFAULT_CHILD_IDLE_REAP_MS = 30 * 60_000;

/**
 * Parse an optional positive-finite-number env value. Returns `undefined`
 * for an unset key so the caller's binding falls back to the vendor's own
 * default rather than this boundary inventing one.
 */
function parsePositiveMsEnv(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `invalid sidecar environment: ${name} must be a positive finite number; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export type SidecarConfig = {
  readonly dataDir: string;
  readonly hubURL: string;
  readonly sidecarId: string;
  readonly token: string;
  readonly path: string;
  readonly home: string | undefined;
  readonly tmpdir: string | undefined;
  /**
   * The operator's tool-registry pin, carried as the validated raw JSON
   * so the boot edge can thread it verbatim into each workflow-process
   * child's spawn env. `undefined` means no pin (the public npmjs
   * default).
   */
  readonly toolRegistries: string | undefined;
  /**
   * Consumed-dedup retention horizon (ms), forwarded verbatim to every
   * deployment's supervisor. `undefined` means the operator did not
   * override it; the supervisor applies `DEFAULT_CONSUMED_RETENTION_MS`
   * (24h).
   */
  readonly consumedRetentionMs: number | undefined;
  /**
   * Spawn ready-handshake timeout (ms), forwarded verbatim to every
   * deployment's supervisor. `undefined` means the operator did not
   * override it; the supervisor applies `DEFAULT_READY_TIMEOUT_MS` (30s).
   */
  readonly readyTimeoutMs: number | undefined;
  /**
   * CL-5477 idle-reap threshold (ms). Always a resolved number (never
   * `undefined`): an unset env var applies `DEFAULT_CHILD_IDLE_REAP_MS`
   * rather than deferring to a vendor default, since reaping defaults ON
   * for this host. `0` means the operator explicitly disabled reaping.
   */
  readonly idleReapMs: number;
};

/**
 * Parse the sidecar's configuration out of an environment map. Throws at
 * the call site when any variable is missing or malformed, naming the
 * variable and the shape it must have, so a misconfigured process dies
 * at boot instead of failing at first use.
 */
export function readSidecarConfig(
  env: Record<string, string | undefined>,
): SidecarConfig {
  const parsed = SidecarEnv(env);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid sidecar environment: ${parsed.summary}`);
  }
  // Validate the registries JSON now so a malformed pin dies at boot
  // with the variable named, not at the first tool materialization
  // inside a workflow-process child.
  if (parsed.SIDECAR_TOOL_REGISTRIES !== undefined) {
    parseToolRegistries(parsed.SIDECAR_TOOL_REGISTRIES);
  }
  return {
    dataDir: parsed.SIDECAR_DATA_DIR,
    hubURL: parsed.HUB_WS_URL,
    sidecarId: parsed.SIDECAR_ID,
    token: parsed.SIDECAR_TOKEN,
    path: parsed.PATH,
    home: parsed.HOME,
    tmpdir: parsed.TMPDIR,
    toolRegistries: parsed.SIDECAR_TOOL_REGISTRIES,
    consumedRetentionMs: parsePositiveMsEnv(
      parsed.CONSUMED_RETENTION_MS,
      "CONSUMED_RETENTION_MS",
    ),
    readyTimeoutMs: parsePositiveMsEnv(
      parsed.CHILD_READY_TIMEOUT_MS,
      "CHILD_READY_TIMEOUT_MS",
    ),
    idleReapMs: parseNonNegativeMsEnv(
      parsed.WORKBENCH_CHILD_IDLE_REAP_MS,
      "WORKBENCH_CHILD_IDLE_REAP_MS",
      DEFAULT_CHILD_IDLE_REAP_MS,
    ),
  };
}

/**
 * Parse a non-negative-integer-milliseconds env value, defaulting to
 * `fallback` when unset. Unlike `parsePositiveMsEnv`'s neighbors, `0` is a
 * legal, meaningful value here (explicit opt-out of reaping), so this
 * rejects only negative or non-integer input, not zero.
 */
function parseNonNegativeMsEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `invalid sidecar environment: ${name} must be a non-negative integer (milliseconds); got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}
