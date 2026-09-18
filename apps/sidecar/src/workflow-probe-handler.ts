// Evaluates a code-sourced workflow's entry to inspect it without
// deploying, so it must never run in the sidecar host's address space:
// this spawns a one-shot child behind an IPC airlock. Reaping is
// sidecar-owned with its own deadline, independent of the hub's probe
// timeout (which only rejects the hub-side promise, never kills the child).

import { fileURLToPath } from "node:url";

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { GrantWalkSnapshot, hexDecode, hexEncode } from "@intx/types";
import type { GrantRequirement } from "@intx/types";
import type { WorkflowProbeRequestFrame } from "@intx/types/sidecar";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";
import { collectDeclaredPluginNames, projectLiveToInert } from "@intx/workflow";
import { walkCapabilities, type CapabilityWalkResult } from "@intx/workflow-deploy";
import {
  DEFAULT_KILL_TIMEOUT_MS,
  MacedEnvelope,
  encodeEnvelope,
  generateChannelId,
  generateHmacKey,
  loadWorkflowDefinitionFromClosure,
  loadWorkflowDirectorRegistryFromClosure,
  loadWorkflowPluginToolDefinitionsFromClosure,
  signHmac,
  verifyHmac,
  type FrameEnvelope,
} from "@intx/workflow-host";

const logger = getLogger(["sidecar", "workflow-probe"]);

const IPC_HMAC_KEY_BYTES = 32;

/** Independent of the hub's probeTimeoutMs, which only rejects the hub-side promise; this is what kills a wedged child. */
export const DEFAULT_PROBE_CHILD_TIMEOUT_MS = 30_000;

/** Mirrors the supervisor's kill timeout so a probe child is force-killed on the same schedule. */
export const DEFAULT_PROBE_CHILD_KILL_TIMEOUT_MS = DEFAULT_KILL_TIMEOUT_MS;

// Env keys the host sets on the child's fresh spawn env. The child reads
// exactly these plus PATH/HOME/TMPDIR (for exec + tmp); nothing else
// crosses the airlock.
const PROBE_CHANNEL_ID_ENV = "PROBE_IPC_CHANNEL_ID";
const PROBE_HMAC_KEY_ENV = "PROBE_IPC_HMAC_KEY";
const PROBE_PACKAGE_DIR_ENV = "PROBE_PACKAGE_DIR";

/** Resolved statically at module load so the spawn surface doesn't depend on a runtime env override. */
const DEFAULT_PROBE_CHILD_BINARY: string = fileURLToPath(
  import.meta.resolve("../bin/workflow-probe-child"),
);

// ---------------------------------------------------------------------------
// Result payload wire (child -> host)
// ---------------------------------------------------------------------------

/** ok: false carries the failure reason so the host rejects with a message rather than a bare "child exited". */
const ProbeResultPayload = type({
  ok: "true",
  projection: "unknown",
  grants: "string[]",
  grantWalkSnapshot: GrantWalkSnapshot,
  wireHash: "string > 0",
}).or({
  ok: "false",
  error: "string",
});
type ProbeResultPayload = typeof ProbeResultPayload.infer;

/** grantWalkSnapshot preserves per-step grouping and effect data the flattened `grants` union discards. */
export interface WorkflowProbeResult {
  readonly projection: WorkflowProjectionDefinition;
  readonly grants: string[];
  readonly grantWalkSnapshot: GrantWalkSnapshot;
  readonly wireHash: string;
}

// ---------------------------------------------------------------------------
// Closure materialization seam
// ---------------------------------------------------------------------------

/** node_modules/ is laid out so the entry's bare-specifier imports resolve; cleanup runs once the child is reaped. */
export interface MaterializedWorkflowClosure {
  readonly packageDir: string;
  cleanup(): Promise<void>;
}

/** Runs on the sidecar host (I/O, not author-code eval), so the airlocked child only does load+evaluate. */
export type MaterializeWorkflowClosure = (
  frame: WorkflowProbeRequestFrame,
) => Promise<MaterializedWorkflowClosure>;

// ---------------------------------------------------------------------------
// Child spawn seam
// ---------------------------------------------------------------------------

/** No control/event channels: the probe carries no bidirectional control traffic. */
export interface ProbeChildHandle {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(signal?: number | string): void;
  readonly exited: Promise<number>;
}

/** Tests inject a spawner that records the pid so they can assert the child was reaped. */
export type ProbeChildSpawner = (args: {
  binaryPath: string;
  env: Record<string, string>;
}) => ProbeChildHandle;

/** No process.env spread — the caller assembles a fresh env. */
export const defaultProbeChildSpawner: ProbeChildSpawner = ({
  binaryPath,
  env,
}): ProbeChildHandle => {
  const proc = Bun.spawn([binaryPath], {
    stdio: ["ignore", "pipe", "inherit"],
    env,
  });
  return {
    pid: proc.pid,
    stdout: proc.stdout,
    kill(signal?: number | string): void {
      if (signal === undefined) {
        proc.kill();
        return;
      }
      if (typeof signal === "number") {
        proc.kill(signal);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the probe reaper passes "SIGTERM"/"SIGKILL"; Bun's runtime accepts the same "SIG*" strings, narrowed back at the boundary.
      proc.kill(signal as NodeJS.Signals);
    },
    exited: proc.exited,
  };
};

// ---------------------------------------------------------------------------
// Executor (host side)
// ---------------------------------------------------------------------------

export interface WorkflowProbeExecutorOpts {
  /** Host-side materializer for the frame's frozen closure. */
  materialize: MaterializeWorkflowClosure;
  /** Override the child spawner (defaults to the Bun.spawn-backed one). */
  spawnProbeChild?: ProbeChildSpawner;
  /** Override the `bin/workflow-probe-child` path. */
  binaryPath?: string;
  /**
   * Self-owned deadline before the child is reaped and the probe fails.
   * Independent of the hub's `probeTimeoutMs`.
   */
  childTimeoutMs?: number;
  /** SIGTERM->SIGKILL escalation window when reaping. */
  killTimeoutMs?: number;
}

/** Satisfies the hub-agent WorkflowProbeExecutor seam; throws so the link answers workflow.probe.error. */
export function createWorkflowProbeExecutor(opts: WorkflowProbeExecutorOpts): {
  probe(frame: WorkflowProbeRequestFrame): Promise<WorkflowProbeResult>;
} {
  const spawnProbeChild = opts.spawnProbeChild ?? defaultProbeChildSpawner;
  const binaryPath = opts.binaryPath ?? DEFAULT_PROBE_CHILD_BINARY;
  const childTimeoutMs = opts.childTimeoutMs ?? DEFAULT_PROBE_CHILD_TIMEOUT_MS;
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_PROBE_CHILD_KILL_TIMEOUT_MS;

  async function probe(frame: WorkflowProbeRequestFrame): Promise<WorkflowProbeResult> {
    const materialized = await opts.materialize(frame);
    try {
      return await runOneShotProbeChild({
        packageDir: materialized.packageDir,
        spawnProbeChild,
        binaryPath,
        childTimeoutMs,
        killTimeoutMs,
      });
    } finally {
      await materialized.cleanup();
    }
  }

  return { probe };
}

interface RunOneShotProbeChildArgs {
  readonly packageDir: string;
  readonly spawnProbeChild: ProbeChildSpawner;
  readonly binaryPath: string;
  readonly childTimeoutMs: number;
  readonly killTimeoutMs: number;
}

/** The finally guarantees the child is killed on every exit path, including a self-owned deadline firing first. */
async function runOneShotProbeChild(args: RunOneShotProbeChildArgs): Promise<WorkflowProbeResult> {
  const channelId = generateChannelId();
  const hmacKey = generateHmacKey();
  const env = buildProbeChildEnv({
    packageDir: args.packageDir,
    channelId,
    hmacKey,
  });
  const handle = args.spawnProbeChild({ binaryPath: args.binaryPath, env });

  let reaped = false;
  async function reap(): Promise<void> {
    if (reaped) return;
    reaped = true;
    await reapChild(handle, args.killTimeoutMs);
  }

  // Attach a catch so a post-reap stdout read error (the kill closes the
  // pipe mid-read) resolves to null instead of surfacing as an unhandled
  // rejection on the losing race branch.
  const linePromise: Promise<string | null> = readResultLine(handle.stdout).catch(
    (err: unknown) => {
      logger.debug`probe child ${String(handle.pid)} stdout read errored: ${errorMessage(err)}`;
      return null;
    },
  );

  const deadline = createDeadline(args.childTimeoutMs);
  try {
    // Child exit is deliberately not a race arm: it would risk winning
    // against an already-written result and failing the probe spuriously.
    // readResultLine already settles on stdout close either way.
    const outcome = await Promise.race([
      linePromise.then((line) => ({ kind: "line" as const, line })),
      deadline.promise.then(() => ({ kind: "timeout" as const })),
    ]);

    if (outcome.kind === "timeout") {
      throw new Error(
        `workflow probe child ${String(handle.pid)} did not produce a result within ${String(args.childTimeoutMs)}ms`,
      );
    }
    if (outcome.line === null) {
      throw new Error(
        `workflow probe child ${String(handle.pid)} closed its output without producing a result`,
      );
    }
    return await parseProbeResult(outcome.line, channelId, hmacKey);
  } finally {
    deadline.cancel();
    await reap();
  }
}

function buildProbeChildEnv(args: {
  packageDir: string;
  channelId: string;
  hmacKey: Uint8Array;
}): Record<string, string> {
  // No process.env spread: no sidecar secret or ambient input crosses the airlock.
  const env: Record<string, string> = {
    [PROBE_CHANNEL_ID_ENV]: args.channelId,
    [PROBE_HMAC_KEY_ENV]: hexEncode(args.hmacKey),
    [PROBE_PACKAGE_DIR_ENV]: args.packageDir,
  };
  const path = process.env["PATH"];
  if (path !== undefined) env["PATH"] = path;
  const home = process.env["HOME"];
  if (home !== undefined) env["HOME"] = home;
  const tmpdir = process.env["TMPDIR"];
  if (tmpdir !== undefined) env["TMPDIR"] = tmpdir;
  return env;
}

/** SIGKILL is unignorable, so `exited` always settles even if the child traps SIGTERM. */
async function reapChild(handle: ProbeChildHandle, killTimeoutMs: number): Promise<void> {
  try {
    handle.kill("SIGTERM");
  } catch (err) {
    logger.debug`probe child ${String(handle.pid)} SIGTERM raised (already exited?): ${errorMessage(err)}`;
  }
  const deadline = createDeadline(killTimeoutMs);
  const first = await Promise.race([
    handle.exited.then(() => "exited" as const),
    deadline.promise.then(() => "deadline" as const),
  ]);
  deadline.cancel();
  if (first === "exited") return;
  logger.warn`workflow probe child ${String(handle.pid)} did not exit on SIGTERM within ${String(killTimeoutMs)}ms; escalating to SIGKILL`;
  try {
    handle.kill("SIGKILL");
  } catch (err) {
    logger.debug`probe child ${String(handle.pid)} SIGKILL raised (already exited?): ${errorMessage(err)}`;
  }
  await handle.exited.catch(() => {
    // A non-zero exit on SIGKILL is the expected outcome; reaping treats
    // child exit as success regardless of code.
  });
}

/** Verifies HMAC before trusting any field, mirroring the event channel's receiver. */
async function parseProbeResult(
  line: string,
  channelId: string,
  hmacKey: Uint8Array,
): Promise<WorkflowProbeResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    throw new Error("workflow probe child result is not valid JSON", { cause });
  }
  const maced = MacedEnvelope(raw);
  if (maced instanceof type.errors) {
    throw new Error(`workflow probe child result envelope failed validation: ${maced.summary}`);
  }
  const envelopeBytes = encodeEnvelope(maced.envelope);
  const macBytes = hexDecode(maced.mac);
  const ok = await verifyHmac(envelopeBytes, macBytes, hmacKey);
  if (!ok) {
    throw new Error(
      `workflow probe child result HMAC did not verify (channelId=${maced.envelope.channelId})`,
    );
  }
  if (maced.envelope.channelId !== channelId) {
    throw new Error(
      `workflow probe child result carried a foreign channelId ${JSON.stringify(maced.envelope.channelId)}`,
    );
  }
  const payload = ProbeResultPayload(maced.envelope.payload);
  if (payload instanceof type.errors) {
    throw new Error(`workflow probe child result payload failed validation: ${payload.summary}`);
  }
  if (!payload.ok) {
    throw new Error(`workflow probe evaluation failed: ${payload.error}`);
  }
  const projection = WorkflowProjectionDefinition(payload.projection);
  if (projection instanceof type.errors) {
    throw new Error(`workflow probe child projection failed validation: ${projection.summary}`);
  }
  return {
    projection,
    grants: payload.grants,
    grantWalkSnapshot: payload.grantWalkSnapshot,
    wireHash: payload.wireHash,
  };
}

// ---------------------------------------------------------------------------
// Child side
// ---------------------------------------------------------------------------

/** Bytes are handed to the OS before the child exits so the result isn't truncated. */
export type ProbeChildLineWriter = (line: string) => Promise<void>;

export interface RunProbeChildOpts {
  /** Raw env the child reads its anchors from (defaults to `process.env`). */
  rawEnv?: Readonly<Record<string, string | undefined>>;
  /** Result-line sink (defaults to a drained `process.stdout` write). */
  writeLine?: ProbeChildLineWriter;
}

/** An eval failure ships as ok: false so the host reaps cleanly instead of seeing a bare crash. */
export async function runWorkflowProbeChildFromProcessEnv(
  opts: RunProbeChildOpts = {},
): Promise<void> {
  const rawEnv = opts.rawEnv ?? process.env;
  const writeLine = opts.writeLine ?? defaultStdoutWriteLine;
  const { channelId, hmacKey, packageDir } = parseProbeChildEnv(rawEnv);

  let payload: ProbeResultPayload;
  try {
    payload = await computeProbePayload(packageDir);
  } catch (err) {
    payload = { ok: false, error: enrichProbeError(err) };
  }

  const envelope: FrameEnvelope = { seq: 0, channelId, payload };
  const envelopeBytes = encodeEnvelope(envelope);
  const mac = hexEncode(await signHmac(envelopeBytes, hmacKey));
  await writeLine(`${JSON.stringify({ envelope, mac })}\n`);
}

async function computeProbePayload(packageDir: string): Promise<ProbeResultPayload> {
  const definition = await loadWorkflowDefinitionFromClosure({ packageDir });
  const projection = projectLiveToInert(definition);
  const wireHash = await computeWireDefinitionHash(projection);
  // Composed from the SAME closure the run-child will use, so director:<id>
  // grants advertised here match what the runtime resolves.
  const directors = await loadWorkflowDirectorRegistryFromClosure({
    packageDir,
  });
  // A plugin reaches an agent only through env.plugins, so without loading
  // its tool definitions here the walk would miss tool:<name> grants and the
  // run-child would later fail closed on an un-approved tool.
  const pluginToolDefinitions = await loadWorkflowPluginToolDefinitionsFromClosure({
    packageDir,
    plugins: collectDeclaredPluginNames(definition),
  });
  const walk = walkCapabilities(definition, directors, pluginToolDefinitions);
  // Fail closed: the runtime never re-gates director:<id>, so this
  // advertisement is the only approval checkpoint for it.
  const [unresolved] = walk.unresolvedDirectors;
  if (unresolved !== undefined) {
    return { ok: false, error: `unresolvable director: ${unresolved}` };
  }
  return {
    ok: true,
    projection,
    grants: collectDeploymentGrants(walk),
    grantWalkSnapshot: buildGrantWalkSnapshot(walk, definition.grantRequirements),
    wireHash,
  };
}

/** Sorting makes the shipped set order-independent. */
function collectDeploymentGrants(walk: CapabilityWalkResult): string[] {
  const grants = new Set<string>();
  for (const declarations of walk.perStep.values()) {
    for (const grant of declarations.grants) {
      grants.add(grant);
    }
  }
  return [...grants].sort();
}

/** Unlike collectDeploymentGrants, preserves per-step grouping and effect data the flattened set discards. */
function buildGrantWalkSnapshot(
  walk: CapabilityWalkResult,
  grantRequirements: readonly GrantRequirement[] | undefined,
): GrantWalkSnapshot {
  const perStep = [...walk.perStep].map(([stepId, declarations]) => ({
    stepId,
    grants: [...declarations.grants],
    grantEffects: Object.fromEntries(declarations.grantEffects),
  }));
  return {
    perStep,
    grantRequirements: [...(grantRequirements ?? [])],
  };
}

interface ProbeChildEnv {
  readonly channelId: string;
  readonly hmacKey: Uint8Array;
  readonly packageDir: string;
}

const NonEmptyString = type("string > 0");

function parseProbeChildEnv(rawEnv: Readonly<Record<string, string | undefined>>): ProbeChildEnv {
  const channelId = requireEnv(rawEnv, PROBE_CHANNEL_ID_ENV);
  const packageDir = requireEnv(rawEnv, PROBE_PACKAGE_DIR_ENV);
  const hmacKeyHex = requireEnv(rawEnv, PROBE_HMAC_KEY_ENV);
  const hmacKey = hexDecode(hmacKeyHex);
  if (hmacKey.length !== IPC_HMAC_KEY_BYTES) {
    throw new Error(
      `workflow probe child env: ${PROBE_HMAC_KEY_ENV} must decode to ${String(IPC_HMAC_KEY_BYTES)} bytes, got ${String(hmacKey.length)}`,
    );
  }
  return { channelId, hmacKey, packageDir };
}

function requireEnv(rawEnv: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = NonEmptyString(rawEnv[key]);
  if (value instanceof type.errors) {
    throw new Error(`workflow probe child env: required key ${key} is unset or empty`);
  }
  return value;
}

function defaultStdoutWriteLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Resolves null when the stream closes without a complete line (the child exited before writing). */
async function readResultLine(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value !== undefined) {
        pending += decoder.decode(value, { stream: true });
        const nl = pending.indexOf("\n");
        if (nl >= 0) {
          return pending.slice(0, nl).replace(/\r$/, "");
        }
      }
      if (done) {
        const trailing = pending.replace(/\r?\n$/, "");
        return trailing.length > 0 ? trailing : null;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function createDeadline(ms: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel(): void {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Node/Bun's module-not-found message shape. The specifier is the missing
// package the workflow entry imported at evaluation time.
const MISSING_MODULE_RE = /Cannot find (?:module|package) ['"]([^'"]+)['"]/;

/** Rewrites "Cannot find module" into an actionable hint: the common cause is a devDependencies-only import. */
export function enrichProbeError(err: unknown): string {
  const message = errorMessage(err);
  const match = MISSING_MODULE_RE.exec(message);
  const specifier = match?.[1];
  if (specifier === undefined) return message;
  return (
    `workflow entry could not resolve ${JSON.stringify(specifier)} from its dependency closure; ` +
    `if the workflow imports it at run time, declare it under "dependencies" rather than "devDependencies" ` +
    `(a devDependencies-only import is not materialized into the closure). ${message}`
  );
}
