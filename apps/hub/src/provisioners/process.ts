import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { reportError } from "@corbits/error-sink";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import type { SidecarCapabilityDeclaration } from "@intx/types";
import { type } from "arktype";

const log = getLogger(["hub", "process-provisioner"]);

// Resolved from `import.meta.dir` rather than cwd so the hub can be launched
// from any working directory on the host.
const DEFAULT_SIDECAR_ENTRY = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "apps",
  "sidecar",
  "src",
  "index.ts",
);

const Environment = type({
  "PROCESS_PROVISIONER_SIDECAR_ENTRY?": "string > 0",
  "PROCESS_PROVISIONER_RUNTIME?": "string > 0",
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "string > 0",
});

export type ProcessProvisionerConfig = {
  readonly runtimePath: string;
  readonly sidecarEntryPath: string;
  readonly allocationsDir: string;
  readonly stateFilePath: string;
  readonly hubWebSocketUrl: string;
  readonly sidecarCredentialEncryptionKey: string;
};

export type ReadProcessProvisionerConfigArgs = {
  readonly env: Record<string, string | undefined>;
  readonly dataDir: string;
  readonly hubWebSocketUrl: string;
};

export function readProcessProvisionerConfig(
  args: ReadProcessProvisionerConfigArgs,
): ProcessProvisionerConfig {
  const parsed = Environment(args.env);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid process provisioner environment: ${parsed.summary}`);
  }
  if (!isAbsolute(args.dataDir)) {
    throw new Error(
      "process provisioner data dir must be an absolute path; got " + JSON.stringify(args.dataDir),
    );
  }
  const sidecarEntryPath = resolve(
    parsed.PROCESS_PROVISIONER_SIDECAR_ENTRY ?? DEFAULT_SIDECAR_ENTRY,
  );
  return {
    runtimePath: parsed.PROCESS_PROVISIONER_RUNTIME ?? process.execPath,
    sidecarEntryPath,
    allocationsDir: resolve(args.dataDir, "allocations"),
    stateFilePath: resolve(args.dataDir, "state.json"),
    hubWebSocketUrl: args.hubWebSocketUrl,
    sidecarCredentialEncryptionKey: parsed.SIDECAR_CREDENTIAL_ENCRYPTION_KEY,
  };
}

export type SpawnSidecarProcessArgs = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
};

export interface SidecarProcessRunner {
  spawn(args: SpawnSidecarProcessArgs): number;
  isAlive(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

export function createBunSidecarProcessRunner(): SidecarProcessRunner {
  return {
    spawn(args) {
      const child = Bun.spawn([...args.command], {
        cwd: args.cwd,
        env: args.env,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      // Unref so hub shutdown does not block on running sidecars; surviving
      // sidecars are recovered from their pid files on the next boot.
      child.unref();
      return child.pid;
    },

    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (isErrnoCode(error, "ESRCH")) return false;
        if (isErrnoCode(error, "EPERM")) return true;
        throw error;
      }
    },

    signal(pid, signal) {
      process.kill(pid, signal);
    },
  };
}

class ProvisionerOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ProvisionerOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

const AllocationRecord = type({
  allocationId: "string > 0",
  sidecarId: "string > 0",
  generation: "number.integer >= 0",
  desiredState: "'ensured' | 'destroyed'",
  externalRef: "string | null",
  updatedAt: "string > 0",
});
export type AllocationRecord = typeof AllocationRecord.infer;

const StateFile = type({
  version: "1",
  records: AllocationRecord.array(),
});

type ObserveEnsureResult =
  | { readonly kind: "observed"; readonly record: AllocationRecord }
  | {
      readonly kind: "rejected";
      readonly code: "stale_generation" | "generation_destroyed" | "request_conflict";
      readonly message: string;
    };

type ObserveDestroyResult =
  | { readonly kind: "observed"; readonly record: AllocationRecord }
  | {
      readonly kind: "rejected";
      readonly code: "stale_generation" | "request_conflict";
      readonly message: string;
    };

export interface AllocationStateStore {
  observeEnsure(args: {
    allocationId: string;
    sidecarId: string;
    generation: number;
  }): Promise<ObserveEnsureResult>;
  observeDestroy(args: {
    allocationId: string;
    sidecarId: string;
    generation: number;
  }): Promise<ObserveDestroyResult>;
  recordUnit(args: {
    allocationId: string;
    generation: number;
    externalRef: string;
  }): Promise<boolean>;
}

export function createAllocationStateStore(statePath: string): AllocationStateStore {
  const records = new Map<string, AllocationRecord>();
  let initialized = false;
  let tail = Promise.resolve();

  async function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) {
        initialized = true;
        return;
      }
      throw new Error(`Unable to read sidecar allocation state ${statePath}`, {
        cause,
      });
    }
    let parsedJSON: unknown;
    try {
      parsedJSON = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Invalid JSON in sidecar allocation state ${statePath}`, { cause });
    }
    const parsed = StateFile(parsedJSON);
    if (parsed instanceof type.errors) {
      throw new Error(`Invalid sidecar allocation state: ${parsed.summary}`);
    }
    for (const record of parsed.records) {
      if (records.has(record.allocationId)) {
        throw new Error(`Duplicate sidecar allocation state for ${record.allocationId}`);
      }
      records.set(record.allocationId, record);
    }
    initialized = true;
  }

  async function persist(nextRecords: ReadonlyMap<string, AllocationRecord>): Promise<void> {
    const contents = `${JSON.stringify(
      { version: 1, records: Array.from(nextRecords.values()) },
      null,
      2,
    )}\n`;
    await writeFileAtomic(statePath, contents);
  }

  return {
    observeEnsure: (args) =>
      runExclusive(async () => {
        await initialize();
        const existing = records.get(args.allocationId);
        if (existing !== undefined) {
          if (existing.sidecarId !== args.sidecarId) {
            return {
              kind: "rejected",
              code: "request_conflict",
              message: `Allocation ${args.allocationId} is already bound to another sidecar`,
            };
          }
          if (existing.generation > args.generation) {
            return {
              kind: "rejected",
              code: "stale_generation",
              message: `Generation ${String(args.generation)} is older than ${String(existing.generation)}`,
            };
          }
          if (existing.generation === args.generation) {
            if (existing.desiredState === "destroyed") {
              return {
                kind: "rejected",
                code: "generation_destroyed",
                message: `Generation ${String(args.generation)} has already been destroyed`,
              };
            }
            return { kind: "observed", record: existing };
          }
        }
        const record: AllocationRecord = {
          allocationId: args.allocationId,
          sidecarId: args.sidecarId,
          generation: args.generation,
          desiredState: "ensured",
          externalRef: null,
          updatedAt: new Date().toISOString(),
        };
        const nextRecords = new Map(records);
        nextRecords.set(args.allocationId, record);
        await persist(nextRecords);
        records.set(args.allocationId, record);
        return { kind: "observed", record };
      }),

    observeDestroy: (args) =>
      runExclusive(async () => {
        await initialize();
        const existing = records.get(args.allocationId);
        if (existing !== undefined) {
          if (existing.sidecarId !== args.sidecarId) {
            return {
              kind: "rejected",
              code: "request_conflict",
              message: `Allocation ${args.allocationId} is already bound to another sidecar`,
            };
          }
          if (existing.generation > args.generation) {
            return {
              kind: "rejected",
              code: "stale_generation",
              message: `Generation ${String(args.generation)} is older than ${String(existing.generation)}`,
            };
          }
          if (existing.generation === args.generation && existing.desiredState === "destroyed") {
            return { kind: "observed", record: existing };
          }
        }
        const record: AllocationRecord = {
          allocationId: args.allocationId,
          sidecarId: args.sidecarId,
          generation: args.generation,
          desiredState: "destroyed",
          externalRef: existing?.externalRef ?? null,
          updatedAt: new Date().toISOString(),
        };
        const nextRecords = new Map(records);
        nextRecords.set(args.allocationId, record);
        await persist(nextRecords);
        records.set(args.allocationId, record);
        return { kind: "observed", record };
      }),

    recordUnit: (args) =>
      runExclusive(async () => {
        await initialize();
        const record = records.get(args.allocationId);
        if (
          record === undefined ||
          record.generation !== args.generation ||
          record.desiredState !== "ensured"
        ) {
          return false;
        }
        const updated: AllocationRecord = {
          ...record,
          externalRef: args.externalRef,
          updatedAt: new Date().toISOString(),
        };
        const nextRecords = new Map(records);
        nextRecords.set(args.allocationId, updated);
        await persist(nextRecords);
        records.set(args.allocationId, updated);
        return true;
      }),
  };
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp.${String(process.pid)}.${randomBytes(8).toString("hex")}`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw cause;
  }
}

const PID_FILE_NAME = "sidecar.pid";
const SIDECAR_DATA_DIR_NAME = "data";
const UNIT_DIR_PREFIX = "gen-";
// Allocation ids name directories on disk, so reject path traversal characters.
const ALLOCATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_POLL_MS = 100;

type StartUnitArgs = {
  readonly allocationId: string;
  readonly sidecarId: string;
  readonly generation: number;
  readonly token: string;
  readonly hubWebSocketUrl: string;
};

function sidecarEnvFor(
  args: StartUnitArgs,
  sidecarDataDir: string,
  sidecarCredentialEncryptionKey: string,
): Record<string, string> {
  const path = process.env["PATH"];
  if (path === undefined || path === "") {
    const error = new Error(
      "the hub process has no PATH to forward; a spawned sidecar cannot resolve its runtime",
    );
    reportError(error, {
      operation: "process-provisioner.missing_path",
      extra: { allocationId: args.allocationId },
    });
    throw new ProvisionerOperationError("missing_path", error.message, false);
  }
  const home = process.env["HOME"];
  const tmpdir = process.env["TMPDIR"];
  const adapterManifest = process.env["SIDECAR_ADAPTER_MANIFEST"];
  return {
    SIDECAR_DATA_DIR: sidecarDataDir,
    HUB_WS_URL: args.hubWebSocketUrl,
    SIDECAR_ID: args.sidecarId,
    SIDECAR_TOKEN: args.token,
    SIDECAR_CREDENTIAL_ENCRYPTION_KEY: sidecarCredentialEncryptionKey,
    PATH: path,
    ...(home === undefined ? {} : { HOME: home }),
    ...(tmpdir === undefined ? {} : { TMPDIR: tmpdir }),
    ...(adapterManifest === undefined ? {} : { SIDECAR_ADAPTER_MANIFEST: adapterManifest }),
  };
}

async function terminate(runner: SidecarProcessRunner, pid: number): Promise<void> {
  if (!runner.isAlive(pid)) return;
  runner.signal(pid, "SIGTERM");
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (runner.isAlive(pid) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, TERMINATION_POLL_MS));
  }
  if (runner.isAlive(pid)) runner.signal(pid, "SIGKILL");
}

async function readPidFile(unitDir: string, allocationId: string): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(resolve(unitDir, PID_FILE_NAME), "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw operationalFailure(
      error,
      "pid_file_read_failed",
      `unable to read the pid file under ${unitDir}`,
      allocationId,
    );
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function externalRefOf(allocationId: string, generation: number, pid: number): string {
  return `${allocationId}:${String(generation)}:${String(pid)}`;
}

function parseExternalRef(externalRef: string): {
  allocationId: string;
  generation: number;
  pid: number;
} | null {
  const parts = externalRef.split(":");
  if (parts.length !== 3) return null;
  const [allocationId, generationText, pidText] = parts;
  if (allocationId === undefined || allocationId === "") return null;
  const generation = Number(generationText);
  const pid = Number(pidText);
  if (!Number.isInteger(generation) || generation < 0) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { allocationId, generation, pid };
}

function generationOf(entryName: string): number | null {
  if (!entryName.startsWith(UNIT_DIR_PREFIX)) return null;
  const generation = Number(entryName.slice(UNIT_DIR_PREFIX.length));
  return Number.isInteger(generation) && generation > 0 ? generation : null;
}

function ignoreNonEmptyOrMissing(error: unknown): void {
  if (
    isErrnoCode(error, "ENOTEMPTY") ||
    isErrnoCode(error, "EEXIST") ||
    isErrnoCode(error, "ENOENT")
  ) {
    return;
  }
  throw error;
}

function operationalFailure(
  error: unknown,
  code: string,
  message: string,
  allocationId: string,
): ProvisionerOperationError {
  if (error instanceof ProvisionerOperationError) return error;
  const refId = reportError(error, {
    operation: `process-provisioner.${code}`,
    extra: { allocationId },
  });
  const detail = error instanceof Error ? error.message : String(error);
  return new ProvisionerOperationError(code, `${message}: ${detail} (${refId})`, true);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const PROVISIONER_API_VERSION = 2 as const;

export const PROCESS_PROVISIONER_ID = "process";

const PROCESS_CAPABILITIES: readonly SidecarCapabilityDeclaration[] = [
  { capability: "runtime:sidecar", state: "available" },
  { capability: "isolation:process", state: "available" },
  { capability: "isolation:container", state: "blocked" },
  { capability: "isolation:vm", state: "blocked" },
];

// Interchange adopts a probe's allocation for the deployment when both
// provisioners share id/apiVersion/fingerprint, which skips redeploying at
// the current pin — so the hub runs a probe instance with a distinct role.
export type ProcessProvisionerRole = "deployment" | "probe";

export type CreateProcessSidecarProvisionerOpts = {
  readonly config: ProcessProvisionerConfig;
  readonly role: ProcessProvisionerRole;
  readonly runner?: SidecarProcessRunner;
  readonly store?: AllocationStateStore;
};

// The binding fingerprint names the backend kind and role only; pinning port
// or install path would strand existing allocations across hub restarts.
export function createProcessSidecarProvisioner(
  opts: CreateProcessSidecarProvisionerOpts,
): SidecarProvisioner {
  const { config } = opts;
  const runner = opts.runner ?? createBunSidecarProcessRunner();
  const store = opts.store ?? createAllocationStateStore(config.stateFilePath);

  function allocationDirOf(allocationId: string): string {
    if (!ALLOCATION_ID_PATTERN.test(allocationId)) {
      throw new ProvisionerOperationError(
        "invalid_allocation_id",
        `allocationId ${JSON.stringify(allocationId)} is not a valid directory name`,
        false,
      );
    }
    return resolve(config.allocationsDir, allocationId);
  }

  function unitDirOf(allocationId: string, generation: number): string {
    return resolve(allocationDirOf(allocationId), `${UNIT_DIR_PREFIX}${String(generation)}`);
  }

  async function startUnit(args: StartUnitArgs): Promise<string> {
    const unitDir = unitDirOf(args.allocationId, args.generation);
    const sidecarDataDir = resolve(unitDir, SIDECAR_DATA_DIR_NAME);
    const env = sidecarEnvFor(args, sidecarDataDir, config.sidecarCredentialEncryptionKey);
    try {
      await mkdir(sidecarDataDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw operationalFailure(
        error,
        "allocation_dir_failed",
        `unable to create unit directory ${unitDir}`,
        args.allocationId,
      );
    }

    let pid: number;
    try {
      pid = runner.spawn({
        command: [config.runtimePath, config.sidecarEntryPath],
        cwd: dirname(config.sidecarEntryPath),
        env,
      });
    } catch (error) {
      throw operationalFailure(
        error,
        "sidecar_spawn_failed",
        `unable to spawn ${config.sidecarEntryPath}`,
        args.allocationId,
      );
    }

    try {
      await writeFile(resolve(unitDir, PID_FILE_NAME), `${String(pid)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      await terminate(runner, pid);
      throw operationalFailure(
        error,
        "pid_file_write_failed",
        `unable to record pid ${String(pid)} for allocation ${args.allocationId}`,
        args.allocationId,
      );
    }
    return externalRefOf(args.allocationId, args.generation, pid);
  }

  async function stopUnit(externalRef: string): Promise<void> {
    const unit = parseExternalRef(externalRef);
    if (unit === null) {
      throw new ProvisionerOperationError(
        "invalid_external_ref",
        `external ref ${JSON.stringify(externalRef)} is not <allocationId>:<generation>:<pid>`,
        false,
      );
    }
    try {
      await terminate(runner, unit.pid);
    } catch (error) {
      throw operationalFailure(
        error,
        "sidecar_terminate_failed",
        `unable to terminate pid ${String(unit.pid)}`,
        unit.allocationId,
      );
    }
    const unitDir = unitDirOf(unit.allocationId, unit.generation);
    try {
      await rm(unitDir, { recursive: true, force: true });
      // Non-recursive rmdir so a still-running newer generation under the
      // same allocation keeps the parent directory.
      await rmdir(allocationDirOf(unit.allocationId)).catch(ignoreNonEmptyOrMissing);
    } catch (error) {
      throw operationalFailure(
        error,
        "allocation_dir_cleanup_failed",
        `unable to remove unit directory ${unitDir}`,
        unit.allocationId,
      );
    }
  }

  async function findUnitsByAllocation(allocationId: string): Promise<readonly string[]> {
    const allocationDir = allocationDirOf(allocationId);
    let entries: string[];
    try {
      entries = await readdir(allocationDir);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return [];
      throw operationalFailure(
        error,
        "allocation_dir_read_failed",
        `unable to list units under ${allocationDir}`,
        allocationId,
      );
    }

    const refs: string[] = [];
    for (const entry of entries) {
      const generation = generationOf(entry);
      if (generation === null) continue;
      const pid = await readPidFile(resolve(allocationDir, entry), allocationId);
      if (pid === null || !runner.isAlive(pid)) continue;
      refs.push(externalRefOf(allocationId, generation, pid));
    }
    return refs;
  }

  async function sweepObsoleteUnits(allocationId: string, keepExternalRef: string): Promise<void> {
    const candidates = await findUnitsByAllocation(allocationId);
    const obsolete = candidates.filter((externalRef) => externalRef !== keepExternalRef);
    for (const externalRef of obsolete) {
      try {
        await stopUnit(externalRef);
      } catch (error) {
        reportError(error, {
          operation: "process-provisioner.sweep_obsolete_unit",
          extra: { allocationId, externalRef },
        });
        log.error`failed to sweep obsolete unit ${externalRef} for allocation ${allocationId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  // Coalesce concurrent ensure() calls for the same allocation so racing
  // reconciler retries cannot spawn duplicate processes.
  const inFlightEnsures = new Map<string, Promise<EnsureSidecarResult>>();

  async function ensureOnce(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    const validation = validateEnsureRequest(request);
    if (validation !== null) {
      return rejected("invalid_ensure_request", validation, false);
    }

    const observation = await store.observeEnsure({
      allocationId: request.allocationId,
      sidecarId: request.sidecarId,
      generation: request.generation,
    });
    if (observation.kind === "rejected") {
      return rejected(observation.code, observation.message, false);
    }
    if (observation.record.externalRef !== null) {
      await sweepObsoleteUnits(request.allocationId, observation.record.externalRef);
      return {
        kind: "accepted",
        externalRef: observation.record.externalRef,
      };
    }

    let externalRef: string;
    try {
      externalRef = await startUnit({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
        token: request.token,
        hubWebSocketUrl: request.hubWebSocketUrl,
      });
    } catch (error) {
      return rejected(...classify(error, "start_unit_failed"));
    }

    const recorded = await store.recordUnit({
      allocationId: request.allocationId,
      generation: request.generation,
      externalRef,
    });
    if (!recorded) {
      await stopUnit(externalRef);
      return rejected(
        "stale_generation",
        `Generation ${String(request.generation)} was superseded while the unit was starting`,
        false,
      );
    }
    await sweepObsoleteUnits(request.allocationId, externalRef);
    return { kind: "accepted", externalRef };
  }

  return {
    id: PROCESS_PROVISIONER_ID,
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `process:v1:${opts.role}`,
    capabilities: PROCESS_CAPABILITIES,

    ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
      const key = request.allocationId;
      const inFlight = inFlightEnsures.get(key);
      if (inFlight !== undefined) {
        return inFlight.then(() => ensureOnce(request));
      }
      const operation = ensureOnce(request);
      inFlightEnsures.set(key, operation);
      const clear = () => {
        if (inFlightEnsures.get(key) === operation) {
          inFlightEnsures.delete(key);
        }
      };
      void operation.then(clear, clear);
      return operation;
    },

    async destroy(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
      const validation = validateDestroyRequest(request);
      if (validation !== null) {
        return rejected("invalid_destroy_request", validation, false);
      }

      const observation = await store.observeDestroy({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
      });
      if (observation.kind === "rejected") {
        return rejected(observation.code, observation.message, false);
      }

      const externalRefs = new Set<string>();
      if (request.externalRef !== undefined) {
        externalRefs.add(request.externalRef);
      } else if (observation.record.externalRef !== null) {
        externalRefs.add(observation.record.externalRef);
      } else {
        for (const externalRef of await findUnitsByAllocation(request.allocationId)) {
          externalRefs.add(externalRef);
        }
      }

      for (const externalRef of externalRefs) {
        try {
          await stopUnit(externalRef);
        } catch (error) {
          return rejected(...classify(error, "destroy_unit_failed"));
        }
      }
      return { kind: "destroyed", cleanup: "confirmed" };
    },
  };
}

function validateEnsureRequest(request: EnsureSidecarRequest): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (request.token === "") return "token must not be empty";
  if (request.hubWebSocketUrl === "") return "hubWebSocketUrl must not be empty";
  if (!Number.isInteger(request.generation) || request.generation < 0) {
    return "generation must be a non-negative integer";
  }
  return null;
}

function validateDestroyRequest(request: DestroySidecarRequest): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (!Number.isInteger(request.generation) || request.generation < 0) {
    return "generation must be a non-negative integer";
  }
  return null;
}

function rejected(code: string, message: string, retryable: boolean) {
  return { kind: "rejected" as const, code, message, retryable };
}

function classify(
  error: unknown,
  defaultCode: string,
): readonly [code: string, message: string, retryable: boolean] {
  if (error instanceof ProvisionerOperationError) {
    return [error.code, error.message, error.retryable];
  }
  return [defaultCode, error instanceof Error ? error.message : String(error), true];
}
