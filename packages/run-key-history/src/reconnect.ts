// CL-6281: closes the one gap `RunKeyHistoryStore` was already
// positioned to close but did not yet act on. `workflow_run.public_key`
// and this package's own current row are both written from the exact
// same authenticated `agent.deploy.ack` event (see `./listener.ts`);
// they diverge only when one write lands and the other is lost --
// e.g. the hub is restarting when a freshly-minted keypair's ack
// arrives, so vendor's `UPDATE workflow_run` never runs while this
// package's independent write either also misses it (nothing to
// recover: the true key is gone with the frame) or lands anyway
// (a partial failure on vendor's side of the very same event; the true
// key survives here). This module repairs the second case: when this
// package's own record disagrees with `workflow_run`, its record wins.
//
// Why this can never become a key-rotation bypass or a hijack:
// - Every row this package holds was written by `./listener.ts` from
//   `agent.deploy.ack`, which only fires for a frame the hub already
//   accepted over an authenticated, address-scoped sidecar connection --
//   the identical trust boundary vendor's own `workflow_run` write
//   relies on. Consulting this table asserts nothing a sidecar itself
//   did not already prove to the hub; it adds no new claimant.
// - `RunKeyHistoryStore.recordObservedKey` is monotonic: the row with
//   `supersededAt === null` is always the LATEST key this address's
//   holder has ever acked, never an older, already-superseded one. So
//   "prefer this package's record on disagreement" can only ever move
//   an address's effective key forward in time, matching the same
//   sidecar's own later ack -- never resurrect a key a legitimate
//   rotation has already retired.
// - Divergence therefore has one honest reading: the address's real
//   holder is the sender of the ack this package recorded, and
//   `workflow_run`'s row is the stale side. There is no reading of the
//   divergence under which `workflow_run`'s key describes a still-live
//   claimant this repair would evict -- that claimant, if one existed,
//   would itself be the source of the later ack this package holds.
// - The reconnect signature challenge is untouched: whichever key this
//   lookup returns still only unlocks a session for whoever can sign
//   with the matching private key. Republishing a wrong guess costs
//   nothing beyond the failed challenge that already happens today; it
//   can never grant a session to a party that cannot produce that
//   signature.
// - Liveness is still the platform's call, not this module's. The repair
//   reads the same `liveWorkflowRunStatuses` gate
//   `@intx/hub-sessions`' own `lookupPublicKey` applies, so a
//   decommissioned run ("failed"/"cancelled", or a "completed" one-shot)
//   stays unchallengeable exactly as it is today. Repairing a stale key
//   must never widen WHICH runs may reconnect -- only which key the
//   challenge targets for a run that was already allowed to.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "@intx/db";
import { liveWorkflowRunStatuses, workflowRun } from "@intx/db/schema";
import type { RunKeyHistoryStore } from "./store";

/**
 * The hub app wires this AFTER the platform's own `lookupPublicKey`,
 * alongside `@corbits/folded-runs`' `lookupFoldedRunReconnectKey`: the
 * platform's answer stands whenever it has one, and this repair is
 * reached only for a live run whose `workflow_run` key the platform
 * could not supply or which disagrees with the last observed ack.
 *
 * Returns `null` when there is nothing to reconcile: this address has
 * never been observed by `./listener.ts` (a pre-existing run, or one
 * this package has not seen a deploy for yet), or it names no LIVE
 * `workflow_run` row (not a run address, or a run the platform's own
 * liveness gate has already retired). In both cases the caller's own
 * next lookup in the chain decides, unchanged.
 */
export async function lookupRunKeyHistoryReconnectKey(
  db: DB["db"],
  store: RunKeyHistoryStore,
  agentAddress: string,
): Promise<string | null> {
  const observed = await store.getCurrent(agentAddress);
  if (observed === null) return null;

  const [row] = await db
    .select({ publicKey: workflowRun.publicKey })
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.address, agentAddress),
        inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
      ),
    )
    .limit(1);

  if (row === undefined) return null;
  if (row.publicKey === observed.publicKey) return observed.publicKey;

  await db
    .update(workflowRun)
    .set({ publicKey: observed.publicKey })
    .where(
      and(
        eq(workflowRun.address, agentAddress),
        inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
      ),
    );

  return observed.publicKey;
}
