// A folded run's `workflow_run.status` cycles to "completed" between
// occurrences as part of its normal wake/redeploy lifecycle (see
// `wake.ts`): each incoming mail is its own run occurrence, and the
// underlying workflow settles into a real, terminal `RunCompleted`
// once it has handled one, waiting to be woken for the next. For a
// one-shot workflow deployment "completed" means done forever, but for
// a folded run it means only "idle until its next message" — the same
// row, same principal, same channel, still alive by this package's own
// contract.
//
// The platform's reconnect-ownership challenge
// (`vendor/intx/hub-sessions`'s `lookupPublicKey`) knows nothing about
// that distinction: it gates a reconnecting sidecar's address claim on
// `isLiveWorkflowRunStatus`, which recognizes only "deployed"/
// "running" as live. A folded run that happens to be between
// occurrences when its sidecar reconnects (e.g. after a hub restart)
// fails that gate, the challenge is rejected as an "Unknown run
// address", and the sidecar tears its still-resident agent down —
// stranding an otherwise-healthy channel until someone manually
// recreates it.
//
// `lookupFoldedRunReconnectKey` is the narrow patch: a second,
// folded-run-aware key lookup the hub app wires in ahead of the
// platform's own, matched only when the run is "completed" AND a
// `folded_run` marker row exists for it — never for "failed" or
// "cancelled", which do mean the run is genuinely gone.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRun } from "@intx/db/schema";
import { foldedRun } from "./schema";

export async function lookupFoldedRunReconnectKey(
  db: DB["db"],
  agentAddress: string,
): Promise<string | null> {
  const row = await db
    .select({ publicKey: workflowRun.publicKey })
    .from(workflowRun)
    .innerJoin(foldedRun, eq(foldedRun.id, workflowRun.id))
    .where(
      and(
        eq(workflowRun.address, agentAddress),
        eq(workflowRun.status, "completed"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  return row?.publicKey ?? null;
}
