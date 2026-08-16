import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { type } from "arktype";

const AllocationRecord = type({
  allocationId: "string > 0",
  sidecarId: "string > 0",
  generation: "number.integer > 0",
  desiredState: "'ensured' | 'destroyed'",
  containerId: "string | null",
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
      readonly code:
        | "stale_generation"
        | "generation_destroyed"
        | "request_conflict";
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
   * Persists the container created for an ensured generation. Returns
   * false (without writing) if the allocation was superseded or
   * destroyed while the docker run was in flight.
   */
  recordContainer(args: {
    allocationId: string;
    generation: number;
    containerId: string;
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
      throw new Error(`Unable to read docker provisioner state ${statePath}`, {
        cause,
      });
    }
    let parsedJSON: unknown;
    try {
      parsedJSON = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`Invalid JSON in docker provisioner state ${statePath}`, {
        cause,
      });
    }
    const parsed = StateFile(parsedJSON);
    if (parsed instanceof type.errors) {
      throw new Error(`Invalid docker provisioner state: ${parsed.summary}`);
    }
    for (const record of parsed.records) {
      if (records.has(record.allocationId)) {
        throw new Error(
          `Duplicate docker provisioner state for ${record.allocationId}`,
        );
      }
      records.set(record.allocationId, record);
    }
    initialized = true;
  }

  async function persist(
    nextRecords: ReadonlyMap<string, AllocationRecord>,
  ): Promise<void> {
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
          containerId: null,
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
          if (
            existing.generation === args.generation &&
            existing.desiredState === "destroyed"
          ) {
            return { kind: "observed", record: existing };
          }
        }
        const record: AllocationRecord = {
          allocationId: args.allocationId,
          sidecarId: args.sidecarId,
          generation: args.generation,
          desiredState: "destroyed",
          containerId: existing?.containerId ?? null,
          tokenHashSha256: existing?.tokenHashSha256 ?? null,
          updatedAt: now().toISOString(),
        };
        const nextRecords = new Map(records);
        nextRecords.set(args.allocationId, record);
        await persist(nextRecords);
        records.set(args.allocationId, record);
        return { kind: "observed", record };
      }),

    recordContainer: (args) =>
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
          containerId: args.containerId,
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
