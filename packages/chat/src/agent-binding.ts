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
import { eq } from "drizzle-orm";
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
  readonly foldedBody: FoldedBody;
  readonly noopInference: boolean;
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
    foldedBody: parsed,
    noopInference: row.noopInference,
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
 * Re-points a stable participant at a freshly launched run. Written
 * after the new run has actually deployed, never before: a repoint that
 * outlives a failed launch would leave the room addressing a run that
 * was rolled back.
 */
export async function repointBinding(
  db: DB["db"],
  stableId: string,
  newRunId: string,
): Promise<void> {
  await db
    .update(workbenchLaunch)
    .set({ currentRunId: newRunId })
    .where(eq(workbenchLaunch.instanceId, stableId));
}
