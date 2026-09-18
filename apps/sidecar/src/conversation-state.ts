// Makes a warm single-step agent's multi-turn conversation durable in the
// workflow-run substrate (not the agent's per-run isogit store, which is
// lost on child respawn), so continuity survives across runs and respawns.
// See docs/sidecar-conversation-durability.md for the on-disk layout,
// substrate-merge constraints, and timing/failure guarantees.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { createConnectorRouter } from "@intx/harness";
import type { ConnectorReplyParts, RouteDecision } from "@intx/harness";
import { createIsogitStore } from "@intx/storage-isogit/node";
import type { Principal, RepoId, RepoStore } from "@intx/hub-sessions/substrate";
import { WORKFLOW_RUN_AGENT_STATE_PREFIX } from "@intx/hub-sessions/substrate";
import {
  ConnectorThreadState,
  TokenUsage,
  type AuditStore,
  type ContextStore,
  type ConversationTurn,
  type InboundMessage,
  type PendingOperation,
  type SendReceipt,
} from "@intx/types/runtime";

const logger = getLogger(["sidecar", "workflow-child", "conversation-state"]);

const CHECKPOINT_FILE = "checkpoint.json";
const CHECKPOINT_META_FILE = "checkpoint.meta.json";
const WAL_DIR = "wal";

/**
 * Compaction interval: fold the WAL into a fresh checkpoint once it holds
 * this many turns since the last checkpoint. Bounds the WAL tail (and so
 * the restore-replay length) between checkpoints. Measurement-tunable
 * (design §6, open question 4); D1 fixes it at 64.
 */
const CHECKPOINT_INTERVAL = 64;

/**
 * WAL directory fan-out bound: turn `seq` lives in bucket
 * `floor(seq / WAL_BUCKET_SIZE)`. Caps any single `wal/<bucket>/` tree at
 * this many entries so no commit re-hashes a tree that grows with the
 * conversation length. Measurement-tunable (design §6, open question 4);
 * D1 fixes it at 128.
 */
const WAL_BUCKET_SIZE = 128;

/** Metadata stamped onto every WAL entry so restore recovers reactor state without a separate log. */
const SnapshotMetadata = type({
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/** Compacted checkpoint blob; validated on read so a corrupt or partial file surfaces rather than half-applies. */
const CheckpointSnapshot = type({
  turns: "unknown[]",
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/** Checkpoint pointer restore reads first; checkpointSeq counts mirror boundaries, not turns, since a boundary may carry zero or many turns. */
const CheckpointMeta = type({
  checkpointSeq: "number",
  turnCount: "number",
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/** One entry per mirror boundary (not per turn); a turnless boundary still writes `turns: []` so its metadata persists. */
const WalEntry = type({
  seq: "number",
  turns: "unknown[]",
  metadata: SnapshotMetadata,
});

/**
 * Loaded conversation snapshot the restore path applies into the warm
 * agent's local store before its reactor loads.
 */
interface LoadedSnapshot {
  turns: ConversationTurn[];
  pendingOperations: PendingOperation[];
  tokenUsage: TokenUsage;
  connectorState: ConnectorThreadState | null;
}

export interface DurableConversationStoreOpts {
  /**
   * Local per-agent isogit store root. Stable across runs (NOT keyed by
   * runId) so a warm agent's reactor loads the same on-disk store on
   * every message; the substrate is the cross-respawn durable mirror of
   * this store's conversation content.
   */
  localStoreDir: string;
  /** Commit signer for the local isogit store. */
  signer: (payload: string) => Promise<string>;
  /** Proxy workflow-run substrate (single-writer via the supervisor). */
  substrate: RepoStore;
  /** Workflow-run repo identity for the deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run repo ref the conversation snapshot is committed to. */
  workflowRunRef: string;
  /** Principal the substrate write is authored under. */
  principal: Principal;
  /**
   * Stable per-agent key the snapshot is filed under
   * (`agent-state/<agentKey>/`). The warm single-step agent's stepId is
   * the natural key: it is stable across that agent's whole lifetime and
   * disjoint from any runId.
   */
  agentKey: string;
}

/**
 * A `ContextStore` for the warm agent whose conversation content is
 * durably mirrored to the workflow-run substrate. The reactor sees a
 * normal `ContextStore` (its per-cycle commits land in the fast local
 * isogit store); `restoreFromSubstrate` and `mirrorToSubstrate` move the
 * conversation between the local store and the durable substrate layout.
 */
export interface DurableConversationStore {
  /**
   * The store the warm agent's env binds as `storage` and `audit`. It is
   * both `ContextStore` (conversation + connector state) and
   * `AuditStore` (tool-authorization records), matching the per-run
   * isogit store the non-warm path uses.
   */
  readonly storage: ContextStore & AuditStore;
  /** Restore prior conversation from the substrate before the agent builds; throws on a corrupt copy rather than starting fresh. */
  restoreFromSubstrate(): Promise<boolean>;
  /** Commit new turns as an O(1) WAL append, compacting into a checkpoint at the compaction interval. */
  mirrorToSubstrate(): Promise<void>;
  /** Advances connector thread state from an inbound message so composeReply can address a threaded reply. */
  seedInbound(message: InboundMessage): Promise<void>;
  /** Threading headers for a reply on the active connector thread; throws NoActiveConnectorThreadError with none seeded. */
  composeReply(): ConnectorReplyParts;
  /** Advances thread state after a reply is sent so the next inbound continuation matches lastMessageId. */
  onReplySent(receipt: SendReceipt): Promise<void>;
}

export async function createDurableConversationStore(
  opts: DurableConversationStoreOpts,
): Promise<DurableConversationStore> {
  await fs.promises.mkdir(opts.localStoreDir, { recursive: true });
  const baseStorage = await createIsogitStore(opts.localStoreDir, opts.signer);

  // Reuse the connector router + the harness storage-override seam. The
  // router's `onStateChanged` is the change-driven commit hook the design
  // names. `seedInbound` drives the router (route + commit) on each inbound
  // mail, so `onStateChanged` fires and enqueues a change-driven mirror
  // behind the seed on the shared serialization tail; the run-boundary
  // mirror still commits every boundary. Both triggers persist state, so a
  // dropped change-driven mirror is recoverable at the next boundary.
  const connectorRouter = createConnectorRouter({
    onStateChanged: () => {
      void mirrorToSubstrate().catch((cause) => {
        logger.error`connector-state-change conversation mirror failed for ${opts.agentKey}: ${cause instanceof Error ? cause.message : String(cause)}`;
      });
    },
  });

  const agentStatePrefix = `${WORKFLOW_RUN_AGENT_STATE_PREFIX}/${encodeURIComponent(opts.agentKey)}/`;

  // The number of mirror boundaries already durably committed (the
  // checkpoint's folded boundaries plus every appended WAL entry). It is
  // the seq of the NEXT WAL entry. `null` until learned -- lazily from the
  // substrate on the first mirror so a respawn-rebuilt store that did NOT
  // restore never re-commits boundaries the substrate already holds.
  let mirroredBoundaryCount: number | null = null;
  // The number of turns already durably committed (checkpoint folded turns
  // plus every turn carried by an appended WAL entry). The next mirror
  // appends only `turns.slice(mirroredTurnCount)`, which is what keeps each
  // append O(1) in the turn count.
  let mirroredTurnCount = 0;
  // The boundary seq the current checkpoint folded to: WAL boundary seqs
  // [checkpointBoundarySeq, mirroredBoundaryCount) are live. Tracked so a
  // mirror knows the live WAL length (mirroredBoundaryCount -
  // checkpointBoundarySeq) and when to compact.
  let checkpointBoundarySeq = 0;

  // Serializes the shared-counter critical section: mirror and restore can
  // re-enter each other (connectorRouter.restore() can fire onStateChanged
  // synchronously), so a single tail prevents two overlapping runs from
  // emitting two WAL entries at the same boundary seq. Does not address the
  // separate reactor-vs-mirror peek-snapshot window documented on runMirror.
  let stateOpTail: Promise<unknown> = Promise.resolve();
  function serializeStateOp<T>(op: () => Promise<T>): Promise<T> {
    const result = stateOpTail.then(op, op);
    stateOpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function restoreFromSubstrate(): Promise<boolean> {
    return serializeStateOp(runRestore);
  }

  function mirrorToSubstrate(): Promise<void> {
    return serializeStateOp(runMirror);
  }

  function seedInbound(message: InboundMessage): Promise<void> {
    return serializeStateOp(() => runSeed(message));
  }

  function composeReply(): ConnectorReplyParts {
    return connectorRouter.composeReply();
  }

  function onReplySent(receipt: SendReceipt): Promise<void> {
    return serializeStateOp(() => runReplySent(receipt));
  }

  function substrateAgentStateFsDir(): string {
    const repoDir = opts.substrate.getRepoDir(opts.workflowRunRepoId);
    return path.join(repoDir, WORKFLOW_RUN_AGENT_STATE_PREFIX, encodeURIComponent(opts.agentKey));
  }

  function bucketOf(seq: number): number {
    return Math.floor(seq / WAL_BUCKET_SIZE);
  }

  function walBucketPrefix(bucket: number): string {
    return `${agentStatePrefix}${WAL_DIR}/${String(bucket)}/`;
  }

  function walEntryPath(seq: number): string {
    return `${walBucketPrefix(bucketOf(seq))}${String(seq)}.json`;
  }

  function checkpointPath(): string {
    return `${agentStatePrefix}${CHECKPOINT_FILE}`;
  }

  function checkpointMetaPath(): string {
    return `${agentStatePrefix}${CHECKPOINT_META_FILE}`;
  }

  async function runRestore(): Promise<boolean> {
    const reconstructed = await reconstructDurableConversation(
      substrateAgentStateFsDir(),
      opts.agentKey,
    );
    if (reconstructed === null) {
      // No durable state yet: the next mirror starts the WAL from an empty
      // checkpoint. Record the (empty) committed counts so the first
      // mirror appends from boundary seq 0.
      mirroredBoundaryCount = 0;
      mirroredTurnCount = 0;
      checkpointBoundarySeq = 0;
      return false;
    }
    // Write the reconstructed turns + metadata into the local store's
    // working tree and commit, so the agent's reactor `load()` reads the
    // restored conversation. `setConnectorState` buffers the connector
    // state for the metadata write; `restore()` mirrors it into the router
    // so a future change-driven mirror carries the right base.
    await baseStorage.writeTurns(reconstructed.turns);
    baseStorage.setConnectorState(reconstructed.connectorState);
    // Set counts before restoring connector state: restore() can fire
    // onStateChanged synchronously and enqueue a mirror, so this keeps the
    // counts correct even if the serialization ordering is ever weakened.
    mirroredBoundaryCount = reconstructed.boundaryCount;
    mirroredTurnCount = reconstructed.totalTurns;
    checkpointBoundarySeq = reconstructed.checkpointBoundarySeq;
    connectorRouter.restore(reconstructed.connectorState);
    await baseStorage.writeMetadata({
      pendingOperations: reconstructed.pendingOperations,
      tokenUsage: reconstructed.tokenUsage,
    });
    await baseStorage.commit({
      message: `restore conversation for ${opts.agentKey} from substrate`,
    });
    return true;
  }

  /** Appends one WAL entry to its bucket; O(bucket size), independent of total turn count N. */
  async function appendWalEntry(
    boundarySeq: number,
    turns: unknown[],
    metadata: {
      pendingOperations: unknown[];
      tokenUsage: TokenUsage;
      connectorState: ConnectorThreadState | null;
    },
  ): Promise<void> {
    const entry = { seq: boundarySeq, turns, metadata };
    const serialized = JSON.stringify(entry);
    const newPath = walEntryPath(boundarySeq);
    await opts.substrate.writeTreePreservingPrefix(
      opts.principal,
      opts.workflowRunRepoId,
      opts.workflowRunRef,
      {
        preservePrefix: walBucketPrefix(bucketOf(boundarySeq)),
        merge: async (existing) => {
          const files: Record<string, string | Uint8Array> = {};
          for (const [blobPath, bytes] of existing) {
            files[blobPath] = bytes;
          }
          files[newPath] = serialized;
          return files;
        },
        message: `append conversation WAL boundary ${String(boundarySeq)} (${String(turns.length)} turn(s)) for ${opts.agentKey}`,
      },
    );
  }

  /** Folds the conversation into a fresh checkpoint and truncates the WAL atomically by omitting wal/ paths from the merge return. */
  async function writeCheckpoint(
    boundarySeq: number,
    turns: unknown[],
    metadata: {
      pendingOperations: unknown[];
      tokenUsage: TokenUsage;
      connectorState: ConnectorThreadState | null;
    },
  ): Promise<void> {
    const snapshot = {
      turns,
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
      connectorState: metadata.connectorState,
    };
    // metadata is the freshest snapshot, so a post-fold restore sees the same metadata the pre-fold WAL tail would have yielded.
    const meta = {
      checkpointSeq: boundarySeq,
      turnCount: turns.length,
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
      connectorState: metadata.connectorState,
    };
    await opts.substrate.writeTreePreservingPrefix(
      opts.principal,
      opts.workflowRunRepoId,
      opts.workflowRunRef,
      {
        preservePrefix: agentStatePrefix,
        merge: async () => ({
          [checkpointPath()]: JSON.stringify(snapshot),
          [checkpointMetaPath()]: JSON.stringify(meta),
        }),
        message: `compact conversation checkpoint at boundary ${String(boundarySeq)} (${String(turns.length)} turns) for ${opts.agentKey}`,
      },
    );
  }

  async function runMirror(): Promise<void> {
    // Reads the reactor's in-memory turn array rather than re-parsing
    // turns.jsonl every boundary; relies on the reactor never appending
    // between its last writeTurns and this peek, which serialization here
    // does not itself enforce.
    const turns = baseStorage.peekTurns();
    const metadata = await baseStorage.loadMetadata();

    // First mirror in this store's lifetime that did not run through
    // `restoreFromSubstrate` (which sets the counts): learn the durable
    // counts from the substrate so the append starts at the right boundary
    // seq and never re-commits boundaries the substrate already holds.
    if (mirroredBoundaryCount === null) {
      const reconstructed = await reconstructDurableConversation(
        substrateAgentStateFsDir(),
        opts.agentKey,
      );
      checkpointBoundarySeq = reconstructed?.checkpointBoundarySeq ?? 0;
      mirroredBoundaryCount = reconstructed?.boundaryCount ?? 0;
      mirroredTurnCount = reconstructed?.totalTurns ?? 0;
    }

    // One WAL entry per boundary, unconditionally, so a turnless boundary
    // (e.g. a throwing send that still advanced tokenUsage) still commits
    // its metadata; the payload is the turn delta, never the whole conversation.
    const newTurns = turns.slice(mirroredTurnCount);
    const boundarySeq = mirroredBoundaryCount;
    await appendWalEntry(boundarySeq, newTurns, metadata);
    mirroredBoundaryCount = boundarySeq + 1;
    // Advance by the count actually persisted -- newTurns is a pre-await
    // snapshot -- not by turns.length. `turns` is the reactor's live array
    // by reference; reading its length after the await would count any turn
    // appended during appendWalEntry as mirrored, so the next mirror would
    // slice past it and drop it from the WAL permanently.
    mirroredTurnCount = mirroredTurnCount + newTurns.length;

    // Compact once the live WAL reaches the interval (measured in mirror
    // boundaries = WAL entries, which bounds both the bucket fan-out and the
    // replay length): fold the full conversation into a fresh checkpoint
    // with the freshest metadata and truncate the WAL. Amortizes the
    // unavoidable O(N) full rewrite to O(N/K) per boundary.
    if (mirroredBoundaryCount - checkpointBoundarySeq >= CHECKPOINT_INTERVAL) {
      await writeCheckpoint(mirroredBoundaryCount, turns.slice(0, mirroredTurnCount), metadata);
      checkpointBoundarySeq = mirroredBoundaryCount;
    }
  }

  // Classify an inbound message, treating a `route()` throw as passthrough.
  // The router throws when `message.headers.from` is not a parseable bare
  // addr-spec; per the router contract that is a passthrough (deliver the
  // message to the agent -- the caller's send is separate -- but do not
  // advance the thread), not a programmer error, so it must not fail the
  // seed. A synthesized passthrough decision commits as a no-op.
  function routeOrPassthrough(message: InboundMessage): RouteDecision {
    try {
      return connectorRouter.route(message);
    } catch (cause) {
      logger.warn`connector route for ${opts.agentKey} could not parse the inbound sender; leaving the thread unadvanced: ${cause instanceof Error ? cause.message : String(cause)}`;
      return { kind: "passthrough" };
    }
  }

  // commit() fires onStateChanged, enqueuing a change-driven mirror that reads
  // connector state from local-store metadata, so the write below is what
  // makes the seeded state reach the substrate.
  async function runSeed(message: InboundMessage): Promise<void> {
    const decision = routeOrPassthrough(message);
    connectorRouter.commit(decision);
    if (decision.kind === "passthrough") return;

    const metadata = await baseStorage.loadMetadata();
    baseStorage.setConnectorState(connectorRouter.snapshot());
    await baseStorage.writeMetadata({
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
    });
    await baseStorage.commit({
      message: `seed connector thread for ${opts.agentKey}`,
    });
  }

  // Same metadata-write pattern as runSeed; onReplySent throws when no thread
  // is active so a phantom advance is never persisted.
  async function runReplySent(receipt: SendReceipt): Promise<void> {
    connectorRouter.onReplySent(receipt);

    const metadata = await baseStorage.loadMetadata();
    baseStorage.setConnectorState(connectorRouter.snapshot());
    await baseStorage.writeMetadata({
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
    });
    await baseStorage.commit({
      message: `advance connector thread after reply for ${opts.agentKey}`,
    });
  }

  return {
    storage: baseStorage,
    restoreFromSubstrate,
    mirrorToSubstrate,
    seedInbound,
    composeReply,
    onReplySent,
  };
}

export interface DurableConversationRegistryOpts {
  /** Sidecar data dir; per-agent local stores root under it. */
  dataDir: string;
  /** Workflow-run repo identity for the deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run repo ref. */
  workflowRunRef: string;
  /** Proxy workflow-run substrate (single-writer via the supervisor). */
  substrate: RepoStore;
  /** Principal the substrate write is authored under. */
  principal: Principal;
  /** Commit signer for the per-agent local isogit stores. */
  signer: (payload: string) => Promise<string>;
}

/** Per-agent store registry, built lazily and reused across runs; empty after a respawn since the substrate is what survives. */
export interface DurableConversationRegistry {
  acquire(key: string): Promise<DurableConversationStore>;
  get(key: string): DurableConversationStore;
}

export function createDurableConversationRegistry(
  opts: DurableConversationRegistryOpts,
): DurableConversationRegistry {
  const stores = new Map<string, DurableConversationStore>();
  // De-dup concurrent first-acquires for the same key so two in-flight
  // step invocations for one warm agent never build two stores (which
  // would double-restore and split the durable mirror).
  const building = new Map<string, Promise<DurableConversationStore>>();

  function localStoreDir(key: string): string {
    return path.join(
      opts.dataDir,
      "agent-conversation-state",
      opts.workflowRunRepoId.id,
      encodeURIComponent(key),
    );
  }

  async function acquire(key: string): Promise<DurableConversationStore> {
    const existing = stores.get(key);
    if (existing !== undefined) return existing;
    const inFlight = building.get(key);
    if (inFlight !== undefined) return inFlight;
    const promise = (async () => {
      const store = await createDurableConversationStore({
        localStoreDir: localStoreDir(key),
        signer: opts.signer,
        substrate: opts.substrate,
        workflowRunRepoId: opts.workflowRunRepoId,
        workflowRunRef: opts.workflowRunRef,
        principal: opts.principal,
        agentKey: key,
      });
      // Restore before the store is observable; a no-op on first-ever run,
      // otherwise pulls the pre-respawn conversation back. A restore failure
      // surfaces rather than silently starting fresh.
      await store.restoreFromSubstrate();
      stores.set(key, store);
      building.delete(key);
      return store;
    })().catch((cause) => {
      building.delete(key);
      throw cause;
    });
    building.set(key, promise);
    return promise;
  }

  function get(key: string): DurableConversationStore {
    const store = stores.get(key);
    if (store === undefined) {
      throw new Error(
        `sidecar conversation-state: no durable conversation store for ${JSON.stringify(key)}; the run-boundary mirror ran before the warm agent's env was built`,
      );
    }
    return store;
  }

  return { acquire, get };
}

interface SnapshotMetadataValue {
  pendingOperations: unknown[];
  tokenUsage: TokenUsage;
  connectorState: ConnectorThreadState | null;
}

/** Reconstructed conversation plus the boundary/turn bookkeeping the mirror path needs to resume appending. */
export interface ReconstructedConversation extends LoadedSnapshot {
  totalTurns: number;
  boundaryCount: number;
  checkpointBoundarySeq: number;
}

/**
 * Pure read: checkpoint turns + replayed WAL tail. Returns `null` on a
 * genuine first-ever run; throws on any corrupt blob or WAL seq gap rather
 * than silently starting fresh or dropping a turn. Exported so a reader
 * (durability test, recovery audit) uses the same reconstruction path the
 * warm agent's restore does.
 */
export async function reconstructDurableConversation(
  agentStateDir: string,
  agentKey: string,
): Promise<ReconstructedConversation | null> {
  const checkpoint = await readCheckpointFromDir(agentStateDir, agentKey);
  const baseBoundarySeq = checkpoint?.checkpointSeq ?? 0;
  const wal = await readWalTailFromDir(agentStateDir, agentKey, baseBoundarySeq);
  if (checkpoint === null && wal.length === 0) return null;

  const turns: unknown[] = [...(checkpoint?.turns ?? [])];
  // The freshest metadata wins: the last WAL entry, or the checkpoint when
  // the WAL is empty. Because every boundary writes a WAL entry, the last
  // entry always carries the latest metadata -- including a turnless
  // boundary that advanced only metadata.
  let metadata: SnapshotMetadataValue = checkpoint?.metadata ?? {
    pendingOperations: [],
    tokenUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    connectorState: null,
  };
  for (const entry of wal) {
    for (const turn of entry.turns) {
      turns.push(turn);
    }
    metadata = entry.metadata;
  }
  return {
    // The reactor re-narrows turn/operation elements on load; the
    // validators below enforce only the structural envelope, matching the
    // boundary the whole-blob mirror used.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- envelope validated in the read helpers; turn element narrows live in the reactor on load
    turns: turns as ConversationTurn[],
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- envelope validated in the read helpers; pending-operation element narrows live in the reactor on load
    pendingOperations: metadata.pendingOperations as PendingOperation[],
    tokenUsage: metadata.tokenUsage,
    connectorState: metadata.connectorState,
    totalTurns: turns.length,
    boundaryCount: baseBoundarySeq + wal.length,
    checkpointBoundarySeq: baseBoundarySeq,
  };
}

/**
 * Read the checkpoint pair from `agentStateDir`. Returns `null` only when
 * no checkpoint exists yet -- which the reconstruction treats as "no
 * folded turns" (any conversation lives entirely in the WAL). A
 * present-but-corrupt or inconsistent checkpoint throws.
 */
async function readCheckpointFromDir(
  agentStateDir: string,
  agentKey: string,
): Promise<{
  turns: unknown[];
  checkpointSeq: number;
  metadata: SnapshotMetadataValue;
} | null> {
  let metaRaw: string;
  try {
    metaRaw = await fs.promises.readFile(path.join(agentStateDir, CHECKPOINT_META_FILE), "utf8");
  } catch (cause) {
    if (isErrnoNotFound(cause)) return null;
    throw cause;
  }
  const meta = parseJsonOrThrow(metaRaw, `${agentKey} ${CHECKPOINT_META_FILE}`);
  const validatedMeta = CheckpointMeta(meta);
  if (validatedMeta instanceof type.errors) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_META_FILE} for ${agentKey} failed validation: ${validatedMeta.summary}; refusing to start the warm agent fresh on a corrupt checkpoint`,
    );
  }
  const snapshotRaw = await fs.promises.readFile(path.join(agentStateDir, CHECKPOINT_FILE), "utf8");
  const snapshot = parseJsonOrThrow(snapshotRaw, `${agentKey} ${CHECKPOINT_FILE}`);
  const validatedSnapshot = CheckpointSnapshot(snapshot);
  if (validatedSnapshot instanceof type.errors) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_FILE} for ${agentKey} failed validation: ${validatedSnapshot.summary}; refusing to start the warm agent fresh on a corrupt checkpoint`,
    );
  }
  if (validatedSnapshot.turns.length !== validatedMeta.turnCount) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_FILE} for ${agentKey} carries ${String(validatedSnapshot.turns.length)} turns but ${CHECKPOINT_META_FILE} reports turnCount ${String(validatedMeta.turnCount)}; the checkpoint pair is inconsistent`,
    );
  }
  return {
    turns: validatedSnapshot.turns,
    checkpointSeq: validatedMeta.checkpointSeq,
    metadata: {
      pendingOperations: validatedSnapshot.pendingOperations,
      tokenUsage: validatedSnapshot.tokenUsage,
      connectorState: validatedSnapshot.connectorState,
    },
  };
}

/** Reads and seq-orders WAL entries >= fromSeq; throws on a corrupt blob or a seq gap rather than silently dropping a boundary. */
async function readWalTailFromDir(
  agentStateDir: string,
  agentKey: string,
  fromSeq: number,
): Promise<{ seq: number; turns: unknown[]; metadata: SnapshotMetadataValue }[]> {
  const walDir = path.join(agentStateDir, WAL_DIR);
  let buckets: string[];
  try {
    buckets = await fs.promises.readdir(walDir);
  } catch (cause) {
    if (isErrnoNotFound(cause)) return [];
    throw cause;
  }
  const entries: {
    seq: number;
    turns: unknown[];
    metadata: SnapshotMetadataValue;
  }[] = [];
  for (const bucket of buckets) {
    const bucketDir = path.join(walDir, bucket);
    const files = await fs.promises.readdir(bucketDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        throw new Error(
          `sidecar conversation-state: unexpected non-JSON WAL entry ${WAL_DIR}/${bucket}/${file} for ${agentKey}`,
        );
      }
      const raw = await fs.promises.readFile(path.join(bucketDir, file), "utf8");
      const parsed = parseJsonOrThrow(raw, `${agentKey} ${WAL_DIR}/${bucket}/${file}`);
      const validated = WalEntry(parsed);
      if (validated instanceof type.errors) {
        throw new Error(
          `sidecar conversation-state: WAL entry ${WAL_DIR}/${bucket}/${file} for ${agentKey} failed validation: ${validated.summary}; refusing to start the warm agent fresh on a corrupt WAL`,
        );
      }
      if (validated.seq < fromSeq) continue;
      entries.push({
        seq: validated.seq,
        turns: validated.turns,
        metadata: {
          pendingOperations: validated.metadata.pendingOperations,
          tokenUsage: validated.metadata.tokenUsage,
          connectorState: validated.metadata.connectorState,
        },
      });
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < entries.length; i += 1) {
    const expected = fromSeq + i;
    const entry = entries[i];
    if (entry === undefined || entry.seq !== expected) {
      throw new Error(
        `sidecar conversation-state: WAL for ${agentKey} has a seq gap (expected ${String(expected)}, found ${String(entry?.seq)}); a lost append would silently drop a boundary's turns and metadata`,
      );
    }
  }
  return entries;
}

function parseJsonOrThrow(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `sidecar conversation-state: ${label} is not valid JSON; refusing to start the warm agent fresh on a corrupt durable copy`,
      { cause },
    );
  }
}

export function isErrnoNotFound(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") return false;
  const code = (cause as { code?: unknown }).code;
  return code === "ENOENT";
}
