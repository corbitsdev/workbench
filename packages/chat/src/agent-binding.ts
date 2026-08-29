// The address→current-run mapping, and the ruling it encodes: a room's
// participant is NOT a run.
//
// The platform fuses a run's identity to its mail address by
// construction — `deriveWorkflowRunId(address)` is the address's local
// part, the deploy front refuses an `(anchorRunId, agentAddress)` pair
// that does not name the same run, and the sidecar keys a run's durable
// event log at `workflow-runs/<sanitized address>/runs/<runId>`. So a
// genuinely fresh run always carries a fresh address, and a dead run's
// address can never be reused without inheriting its terminal log.
//
// A chat room cannot afford that. The room is data — its timeline,
// settings, threads, and participant records all key off ONE stable id
// — and a run that dies mid-turn must be replaceable without the room
// moving. `workbench_launch` is where the two identities come apart:
// `instanceId` is the stable id the room addresses forever, and
// `currentRunId` is the run executing behind it right now, re-pointed
// by every relaunch. The old run's terminal log is never reclaimed or
// erased; it stays readable through the platform's own run routes,
// which is the whole audit-trail argument for relaunching rather than
// resurrecting.
import { asc, eq } from "drizzle-orm";
import { type } from "arktype";
import type { DB } from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import { formatRunAddress } from "@intx/types";
import { FoldedBodySchema, isFoldedRunSettled } from "@corbits/folded-runs";
import type { FoldedBody } from "@intx/workflow-deploy";
import { workbenchLaunch } from "./schema";
import { domainOf, localPartOf } from "./agent-address";

/**
 * The mapping row, parsed. `stableId`/`roomAddress` are what the room
 * knows; `currentRunId`/`liveAddress` are what the sidecar knows. Only
 * the second pair moves.
 */
export interface AgentBinding {
  readonly tenantId: string;
  readonly stableId: string;
  readonly roomAddress: string;
  readonly currentRunId: string;
  readonly liveAddress: string;
  /** Every run this participant used to be, oldest first. */
  readonly priorRunIds: readonly string[];
  readonly foldedBody: FoldedBody;
  /** See `workbenchLaunch.sourcesDigest`. */
  readonly sourcesDigest: string | null;
}

/**
 * How far back `prior_run_ids` remembers. Long enough that a room can
 * survive a bad afternoon and still hand back an attachment from
 * before it, short enough that the column never becomes an unbounded
 * append log on a row read on every single message.
 */
const PRIOR_RUN_HISTORY_LIMIT = 20;

const PriorRunIdsSchema = type("string[]");

function priorRunIdsFrom(row: LaunchRow): readonly string[] {
  const parsed = PriorRunIdsSchema(row.priorRunIds);
  if (parsed instanceof type.errors) {
    throw new Error(
      `workbench_launch row for "${row.instanceId}" carries an invalid ` +
        `prior-run history: ${parsed.summary}`,
    );
  }
  return parsed;
}

/** The live `workflow_run` row behind a binding, plus the binding itself. */
export interface LiveAgent {
  readonly binding: AgentBinding;
  readonly run: {
    readonly id: string;
    readonly tenantId: string;
    readonly definitionId: string | null;
    readonly principalId: string | null;
    readonly address: string | null;
    readonly status: string;
  };
}

type LaunchRow = typeof workbenchLaunch.$inferSelect;

function bindingFrom(row: LaunchRow, domain: string): AgentBinding {
  const parsed = FoldedBodySchema(row.foldedBody);
  if (parsed instanceof type.errors) {
    throw new Error(
      `workbench_launch row for "${row.instanceId}" carries an invalid ` +
        `folded body: ${parsed.summary}`,
    );
  }
  return {
    tenantId: row.tenantId,
    stableId: row.instanceId,
    roomAddress: formatRunAddress(row.instanceId, domain),
    currentRunId: row.currentRunId,
    liveAddress: formatRunAddress(row.currentRunId, domain),
    priorRunIds: priorRunIdsFrom(row),
    foldedBody: parsed,
    sourcesDigest: row.sourcesDigest ?? null,
  };
}

function requireDomain(address: string): string {
  const domain = domainOf(address);
  if (domain === undefined || domain.length === 0) {
    throw new Error(`malformed agent address, missing "@": ${address}`);
  }
  return domain;
}

async function readLaunchRow(
  db: DB["db"],
  column: "instanceId" | "currentRunId",
  value: string,
): Promise<LaunchRow | undefined> {
  const rows = await db
    .select()
    .from(workbenchLaunch)
    .where(eq(workbenchLaunch[column], value))
    .limit(1);
  return rows[0];
}

/**
 * The binding an address names, whichever side of the mapping it is on:
 * the stable room address the participant records hold, or the live
 * deployment address the sidecar's event stream reports. Both resolve to
 * the same binding, which is exactly what lets an inbound reply from a
 * relaunched run still find the room that has been addressing it under
 * its original name all along.
 */
export async function readBindingByAddress(
  db: DB["db"],
  address: string,
): Promise<AgentBinding | undefined> {
  const domain = requireDomain(address);
  const localPart = localPartOf(address);
  const byStableId = await readLaunchRow(db, "instanceId", localPart);
  if (byStableId !== undefined) return bindingFrom(byStableId, domain);
  const byRunId = await readLaunchRow(db, "currentRunId", localPart);
  return byRunId === undefined ? undefined : bindingFrom(byRunId, domain);
}

/**
 * The address the ROOM knows this agent by, for an address the sidecar
 * reported. Returns the input unchanged when it names no launch this
 * package owns — an echo instance on the shared event stream is not
 * this mapping's business.
 */
export async function resolveRoomAddress(
  db: DB["db"],
  liveAddress: string,
): Promise<string> {
  const binding = await readBindingByAddress(db, liveAddress);
  return binding?.roomAddress ?? liveAddress;
}

async function readRun(
  db: DB["db"],
  runId: string,
): Promise<LiveAgent["run"] | undefined> {
  return db.query.workflowRun.findFirst({ where: eq(workflowRun.id, runId) });
}

/** The binding plus its live run row, or `undefined` when either is missing. */
export async function resolveLiveAgent(
  db: DB["db"],
  binding: AgentBinding,
): Promise<LiveAgent | undefined> {
  const run = await readRun(db, binding.currentRunId);
  return run === undefined ? undefined : { binding, run };
}

/**
 * The live run behind a stable participant id, with the binding that
 * names it. The mail domain is read off the live run's own address
 * rather than taken from a caller — a stable id alone does not carry
 * one, and the run is the only row that does.
 */
export async function resolveLiveByStableId(
  db: DB["db"],
  stableId: string,
): Promise<LiveAgent | undefined> {
  const row = await readLaunchRow(db, "instanceId", stableId);
  if (row === undefined) return undefined;
  const run = await readRun(db, row.currentRunId);
  if (run === undefined || run.address === null) return undefined;
  return { binding: bindingFrom(row, requireDomain(run.address)), run };
}

/**
 * The oldest standing `workbench_launch` in this tenant whose live run
 * is the same agent as `definitionId` — row-id match first, else the
 * definition's asset (a re-projected authored row over the same asset
 * is the same principal, not a sibling). Invite reuses this binding
 * instead of minting Sales-2.
 */
export async function findStandingLaunchByDefinition(
  db: DB["db"],
  input: {
    readonly tenantId: string;
    readonly definitionId: string;
    readonly resolveDefinitionAssetId: (
      definitionId: string,
    ) => Promise<string | undefined>;
  },
): Promise<AgentBinding | undefined> {
  const rows = await db
    .select()
    .from(workbenchLaunch)
    .where(eq(workbenchLaunch.tenantId, input.tenantId))
    .orderBy(asc(workbenchLaunch.createdAt));
  const invitedAssetId = await input.resolveDefinitionAssetId(
    input.definitionId,
  );
  for (const row of rows) {
    const run = await readRun(db, row.currentRunId);
    if (run === undefined || run.address === null) continue;
    const liveDefinitionId = run.definitionId;
    if (liveDefinitionId === input.definitionId) {
      return bindingFrom(row, requireDomain(run.address));
    }
    if (invitedAssetId === undefined || liveDefinitionId === null) continue;
    const liveAssetId = await input.resolveDefinitionAssetId(liveDefinitionId);
    if (liveAssetId === invitedAssetId) {
      return bindingFrom(row, requireDomain(run.address));
    }
  }
  return undefined;
}

/**
 * The runs this participant used to be, newest first — the order
 * `fetchBlob` walks them in, so the most recently retired session is
 * tried before older ones. A retired run whose row has since been
 * deleted is skipped rather than raising: history that no longer
 * exists is not an error, it is just history that cannot answer.
 */
export async function readPriorRuns(
  db: DB["db"],
  binding: AgentBinding,
): Promise<LiveAgent["run"][]> {
  const runs: LiveAgent["run"][] = [];
  for (const runId of [...binding.priorRunIds].reverse()) {
    const run = await readRun(db, runId);
    if (run !== undefined) runs.push(run);
  }
  return runs;
}

/**
 * The statuses a `workflow_run` can hold that mean "this run will never
 * accept mail again". A folded run's own idle settle lands on
 * "completed" too (see `@corbits/folded-runs`' `isFoldedRunSettled`),
 * and that one is ordinary — it wakes.
 */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
  "canceled",
  "completed",
]);

/**
 * Whether this run is routable-but-dead: terminal in the hub's own
 * `workflow_run.status`, and not merely a folded run parked between
 * messages. A run this returns true for cannot be woken — its durable
 * event log already carries a terminal event, so redeploying the same
 * address would come straight back as `workflow_run_terminal` — it can
 * only be RELAUNCHED as a fresh run.
 */
export async function isBeyondWake(
  db: DB["db"],
  run: { id: string; status: string },
): Promise<boolean> {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return false;
  return !(await isFoldedRunSettled(db, run));
}

/**
 * Re-points a stable participant at a freshly launched run, retiring
 * the run it was pointing at into `priorRunIds`. Written after the new
 * run has actually deployed, never before: a repoint that outlives a
 * failed launch would leave the room addressing a run that was rolled
 * back.
 */
export async function repointBinding(
  db: DB["db"],
  binding: AgentBinding,
  newRunId: string,
  sourcesDigest: string,
): Promise<void> {
  const history = [...binding.priorRunIds, binding.currentRunId].slice(
    -PRIOR_RUN_HISTORY_LIMIT,
  );
  await db
    .update(workbenchLaunch)
    .set({ currentRunId: newRunId, priorRunIds: history, sourcesDigest })
    .where(eq(workbenchLaunch.instanceId, binding.stableId));
}

/**
 * Records the inference chain a deploy just pinned for the participant
 * `stableId` names — a wake, or a standalone launch whose mapping row
 * `workbenchLaunchPersistExtra` wrote before the deploy resolved — so
 * the next send can tell whether the tenant's catalog (a rotated key, a
 * moved endpoint) has moved on from it since.
 */
export async function recordSourcesDigest(
  db: DB["db"],
  stableId: string,
  sourcesDigest: string,
): Promise<void> {
  await db
    .update(workbenchLaunch)
    .set({ sourcesDigest })
    .where(eq(workbenchLaunch.instanceId, stableId));
}

/**
 * Every participant a tenant has launched, with its live run, for the
 * pass that re-checks each one's inference chain after a provider
 * credential changes (`platform-adapter.ts`'s
 * `reconcileInferenceSources`). Bounded like `listLaunchesBeyondWake`.
 */
export async function listLaunchesForTenant(
  db: DB["db"],
  tenantId: string,
  limit: number,
): Promise<LiveAgent[]> {
  const rows = await db
    .select()
    .from(workbenchLaunch)
    .where(eq(workbenchLaunch.tenantId, tenantId))
    .limit(limit);
  const live: LiveAgent[] = [];
  for (const row of rows) {
    const run = await readRun(db, row.currentRunId);
    if (run === undefined || run.address === null) continue;
    live.push({ binding: bindingFrom(row, requireDomain(run.address)), run });
  }
  return live;
}

/**
 * Every participant whose current run is beyond waking, for the boot
 * sweep that relaunches them (`platform-adapter.ts`'s
 * `sweepTerminalRuns`). Bounded by `limit` rather than streaming the
 * whole table: a sweep is a best-effort recovery pass at start-up, not
 * a migration, and an unbounded one on a large tenant would turn every
 * boot into a deploy storm.
 */
export async function listLaunchesBeyondWake(
  db: DB["db"],
  limit: number,
): Promise<LiveAgent[]> {
  const rows = await db.select().from(workbenchLaunch).limit(limit);
  const dead: LiveAgent[] = [];
  for (const row of rows) {
    const run = await readRun(db, row.currentRunId);
    if (run === undefined || run.address === null) continue;
    if (!(await isBeyondWake(db, run))) continue;
    dead.push({ binding: bindingFrom(row, requireDomain(run.address)), run });
  }
  return dead;
}
