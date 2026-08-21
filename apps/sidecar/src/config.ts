// The one boundary that reads the process environment. Everything the
// host needs from the outside world is an irreducible process fact:
// where to keep durable state, where the hub is, who this sidecar is to
// that hub, and the OS facts a spawned workflow-process child cannot
// function without. Anything else the host learns is data it is told
// over the wire, never configuration.

import { type } from "arktype";

import { AdapterManifest } from "@intx/inference";

import { parseToolRegistries } from "./tool-materialization";

/**
 * The shipped default manifest: registers `@corbits/ollama-adapter`'s
 * `createOllamaAdapter` for the `"ollama"` provider key so a seeded
 * Ollama deployment's `quirks.numCtx` (see `@corbits/hub-client`'s
 * seed and `./workflow-substrate-factory/context-budget`) actually
 * reaches Ollama's `options.num_ctx` instead of silently falling back
 * to the built-in adapter's defaults. An operator who sets
 * `SIDECAR_ADAPTER_MANIFEST` explicitly gets exactly what they wrote --
 * this default never merges with an operator value, only replaces the
 * unset case.
 */
const DEFAULT_ADAPTER_MANIFEST: AdapterManifest = [
  {
    provider: "ollama",
    specifier: "@corbits/ollama-adapter",
    export: "createOllamaAdapter",
  },
];

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
  // Optional JSON-encoded custom inference adapter manifest override
  // (`AdapterManifestEntry[]`, `[{"provider","specifier","export"}]`).
  // Unset resolves to `DEFAULT_ADAPTER_MANIFEST` (the shipped Ollama
  // adapter); set, it replaces that default entirely rather than merging
  // with it. Validated here so a malformed manifest kills the boot with
  // the variable named, and threaded (as its parsed form) into both this
  // process's own adapter registry and every workflow-process child's
  // `SIDECAR_ADAPTER_MANIFEST` substrate-config entry, so a child
  // resolves the exact adapters this boot edge resolved.
  "SIDECAR_ADAPTER_MANIFEST?": "string",
  // Operator overrides for two workflow-supervisor timing bindings,
  // threaded verbatim to every deployment's supervisor
  // (`createSidecarWorkflowSupervisor`'s `consumedRetentionMs` /
  // `readyTimeoutMs`). Unset leaves each supervisor on the vendor's own
  // default (`DEFAULT_CONSUMED_RETENTION_MS` / `DEFAULT_READY_TIMEOUT_MS`).
  // Validated as positive-finite-number strings, matching the
  // `SIDECAR_CACHE_MAX_BYTES`-style numeric env keys.
  "CONSUMED_RETENTION_MS?": "string",
  "CHILD_READY_TIMEOUT_MS?": "string",
});

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
   * The inference adapter manifest, already validated against
   * {@link AdapterManifest}: {@link DEFAULT_ADAPTER_MANIFEST} unless the
   * operator set `SIDECAR_ADAPTER_MANIFEST`, in which case it is exactly
   * (and only) what the operator wrote.
   */
  readonly adapterManifest: AdapterManifest;
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
};

/**
 * Parse the optional `SIDECAR_ADAPTER_MANIFEST` env value into a validated
 * {@link AdapterManifest}. Unset resolves to {@link DEFAULT_ADAPTER_MANIFEST}
 * (the shipped Ollama adapter, so `num_ctx` reaches Ollama without operator
 * configuration); a malformed value dies at boot with the variable named,
 * rather than surfacing as a deep-stack `loadAdapterRegistry` import
 * failure.
 */
export function parseSidecarAdapterManifest(
  raw: string | undefined,
): AdapterManifest {
  if (raw === undefined) return DEFAULT_ADAPTER_MANIFEST;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      "invalid sidecar environment: SIDECAR_ADAPTER_MANIFEST is not valid JSON",
      { cause },
    );
  }
  const validated = AdapterManifest(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `invalid sidecar environment: SIDECAR_ADAPTER_MANIFEST failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

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
    adapterManifest: parseSidecarAdapterManifest(
      parsed.SIDECAR_ADAPTER_MANIFEST,
    ),
    consumedRetentionMs: parsePositiveMsEnv(
      parsed.CONSUMED_RETENTION_MS,
      "CONSUMED_RETENTION_MS",
    ),
    readyTimeoutMs: parsePositiveMsEnv(
      parsed.CHILD_READY_TIMEOUT_MS,
      "CHILD_READY_TIMEOUT_MS",
    ),
  };
}
