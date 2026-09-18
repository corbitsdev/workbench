// Backend-agnostic lifecycle: a backend supplies only start/stop/find and
// identity; this module owns correctness under concurrent and
// out-of-order ensure()/destroy() calls.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256 } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import type { SidecarCapabilityDeclaration } from "@intx/types";
import { type } from "arktype";

const log = getLogger(["hub", "sandbox-sidecar"]);

export type StartUnitArgs = {
  readonly allocationId: string;
  readonly sidecarId: string;
  readonly generation: number;
  readonly token: string;
  readonly hubWebSocketUrl: string;
};

export interface SidecarBackend {
  /** Starts a compute unit for this allocation, returning its external ref. */
  startUnit(args: StartUnitArgs): Promise<string>;
  /** Stops and removes a unit, treating "already gone" as success. */
  stopUnit(externalRef: string): Promise<void>;
  /** Lists the external refs of every unit still labeled for this allocation. */
  findUnitsByAllocation(allocationId: string): Promise<readonly string[]>;
}

/** Lets a backend report a classified, retryable-or-not failure instead of a generic Error. */
export class BackendOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "BackendOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A ladder: a container also isolates the process, a VM also isolates the
 * container. A backend declares every rung it reaches as available so a
 * deployment requiring isolation:vm fails closed rather than landing quietly
 * on a shared kernel.
 */
export const SIDECAR_ISOLATION_LEVELS = ["process", "container", "vm"] as const;

export type SidecarIsolationLevel = (typeof SIDECAR_ISOLATION_LEVELS)[number];

/** Every shipped backend runs a workbench sidecar; nothing else does. */
export const SIDECAR_RUNTIME_CAPABILITY = "runtime:sidecar";

export function sidecarCapabilityDeclarations(
  isolation: SidecarIsolationLevel,
): readonly SidecarCapabilityDeclaration[] {
  const reached = SIDECAR_ISOLATION_LEVELS.indexOf(isolation);
  return [
    { capability: SIDECAR_RUNTIME_CAPABILITY, state: "available" },
    ...SIDECAR_ISOLATION_LEVELS.map((level, index) => ({
      capability: `isolation:${level}`,
      state: index <= reached ? ("available" as const) : ("blocked" as const),
    })),
  ];
}

const AllocationRecord = type({
  allocationId: "string > 0",
  sidecarId: "string > 0",
  generation: "number.integer >= 0",
  desiredState: "'ensured' | 'destroyed'",
  externalRef: "string | null",
  tokenHashSha256: "string | null",
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
  /**
   * Records the intent to ensure this generation. Rejects a generation
   * older than one already observed, and rejects if this allocationId's
   * current generation was already tombstoned as destroyed.
   */
  observeEnsure(args: {
    allocationId: string;
    sidecarId: string;
    generation: number;
  }): Promise<ObserveEnsureResult>;
  /**
   * Records the intent to destroy this generation as a tombstone, so a
   * delayed/older ensure() observed afterward is rejected.
   */
  observeDestroy(args: {
    allocationId: string;
    sidecarId: string;
    generation: number;
  }): Promise<ObserveDestroyResult>;
  /**
   * Persists the compute unit started for an ensured generation. Returns
   * false (without writing) if the allocation was superseded or
   * destroyed while the unit was starting.
   */
  recordUnit(args: {
    allocationId: string;
    generation: number;
    externalRef: string;
    tokenHashSha256: string;
  }): Promise<boolean>;
  getRecord(allocationId: string): Promise<AllocationRecord | null>;
}

type CreateAllocationStateStoreOpts = {
  readonly now?: () => Date;
  readonly writeStateFile?: (path: string, contents: string) => Promise<void>;
};

export function createAllocationStateStore(
  statePath: string,
  opts: CreateAllocationStateStoreOpts = {},
): AllocationStateStore {
  const now = opts.now ?? (() => new Date());
  const writeStateFile = opts.writeStateFile ?? writeFileAtomic;
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
      if (isErrorCode(cause, "ENOENT")) {
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
      throw new Error(`Invalid JSON in sidecar allocation state ${statePath}`, {
        cause,
      });
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
    await writeStateFile(statePath, contents);
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
          tokenHashSha256: null,
          updatedAt: now().toISOString(),
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
          tokenHashSha256: existing?.tokenHashSha256 ?? null,
          updatedAt: now().toISOString(),
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
          tokenHashSha256: args.tokenHashSha256,
          updatedAt: now().toISOString(),
        };
        const nextRecords = new Map(records);
        nextRecords.set(args.allocationId, updated);
        await persist(nextRecords);
        records.set(args.allocationId, updated);
        return true;
      }),

    getRecord: (allocationId) =>
      runExclusive(async () => {
        await initialize();
        return records.get(allocationId) ?? null;
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

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export type CreateSidecarProvisionerOpts = {
  readonly id: string;
  readonly apiVersion: 1;
  readonly bindingFingerprint: string;
  /**
   * Empty matches any deployment stating no requirement — the behaviour
   * every allocation had before capability selection replaced placement.
   */
  readonly capabilities: readonly SidecarCapabilityDeclaration[];
  readonly backend: SidecarBackend;
  readonly store: AllocationStateStore;
};

export function createSidecarProvisioner(opts: CreateSidecarProvisionerOpts): SidecarProvisioner {
  const { backend, store } = opts;

  // Coalesces concurrent ensure() calls for the same allocation so two
  // callers racing the reconciler's ~1s retry loop cannot both pass
  // observeEnsure() before either has recorded a unit, each starting its
  // own compute unit.
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
      await sweepObsoleteUnits(backend, request.allocationId, observation.record.externalRef);
      return {
        kind: "accepted",
        externalRef: observation.record.externalRef,
      };
    }

    const tokenHashSha256 = await hashToken(request.token);
    let externalRef: string;
    try {
      externalRef = await backend.startUnit({
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
      tokenHashSha256,
    });
    if (!recorded) {
      await backend.stopUnit(externalRef);
      return rejected(
        "stale_generation",
        `Generation ${String(request.generation)} was superseded while the unit was starting`,
        false,
      );
    }
    // Covers three cases indistinguishable from here (superseded generation,
    // a losing concurrent ensure(), a crash between startUnit and
    // recordUnit) with one sweep by allocation.
    await sweepObsoleteUnits(backend, request.allocationId, externalRef);
    return { kind: "accepted", externalRef };
  }

  return {
    id: opts.id,
    apiVersion: opts.apiVersion,
    bindingFingerprint: opts.bindingFingerprint,
    capabilities: opts.capabilities,

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
        for (const externalRef of await backend.findUnitsByAllocation(request.allocationId)) {
          externalRefs.add(externalRef);
        }
      }

      for (const externalRef of externalRefs) {
        try {
          await backend.stopUnit(externalRef);
        } catch (error) {
          return rejected(...classify(error, "destroy_unit_failed"));
        }
      }
      return { kind: "destroyed" };
    },
  };
}

/** Best-effort: a sweep failure only leaks a unit, so it's logged rather than failing ensure(). */
async function sweepObsoleteUnits(
  backend: SidecarBackend,
  allocationId: string,
  keepExternalRef: string,
): Promise<void> {
  const candidates = await backend.findUnitsByAllocation(allocationId);
  const obsolete = candidates.filter((externalRef) => externalRef !== keepExternalRef);
  for (const externalRef of obsolete) {
    try {
      await backend.stopUnit(externalRef);
    } catch (error) {
      log.error`failed to sweep obsolete unit ${externalRef} for allocation ${allocationId}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
}

async function hashToken(token: string): Promise<string> {
  const digest = await sha256(token);
  return Buffer.from(digest).toString("hex");
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
  if (error instanceof BackendOperationError) {
    return [error.code, error.message, error.retryable];
  }
  return [defaultCode, error instanceof Error ? error.message : String(error), true];
}
