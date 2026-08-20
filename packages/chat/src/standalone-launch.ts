// CL-6367: the relaunch mapping for agent runs launched OUTSIDE a chat
// room's own launch paths — a routine fire, a webhook delivery.
//
// Chat's relaunch machinery (`./agent-binding.ts`, `./platform-adapter.ts`'s
// `sweepTerminalRuns`/`wakeByAddress`) resolves every participant through
// the `workbench_launch` mapping: stable participant id → current run.
// A run launched with no row in that mapping is invisible to all of it —
// after a sidecar restart marks the run terminal, the sweep never finds
// it, the wake path cannot resolve it, and its next occurrence 409s
// (`workflow_run_terminal`) forever. These exports are what a standalone
// launcher passes to `launchFoldedRun` so its run rides the exact same
// relaunch path a room-invited agent does: the section mode the deploy
// pins, and the `persistExtra` that writes the mapping row inside the
// launch transaction itself.
import type { DBExecutor } from "@intx/db";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { FoldedRunMode } from "@corbits/folded-runs";
import { workbenchLaunch } from "./schema";
import { CHAT_TURN_TIMEOUT_MS } from "./turn-claims";

/**
 * The shape every launched agent run deploys as — chat's room invites
 * and standalone routine/webhook launches alike: an `onTrigger` section
 * (CL-6329), one warm run per agent, each inbound message an occurrence
 * running as its own child run (`turn__<n>`) with its own event log.
 * That child id is what a reply's `run_id` carries, which is the whole
 * reason a reply is traceable.
 *
 * `onBodyFailure: "continue"` — authored in the section shape itself
 * (`@corbits/agent-runtime`) — is the failure edge: a turn that throws
 * records a failed occurrence and leaves the section subscribed, so one
 * bad turn kills neither the agent nor the conversation.
 */
export const AGENT_SECTION_MODE: FoldedRunMode = {
  kind: "section",
  turnTimeoutMs: CHAT_TURN_TIMEOUT_MS,
};

/**
 * The `persistExtra` a standalone launch hands `launchFoldedRun`: the
 * `workbench_launch` row that starts the run's life with the identity
 * mapping (stable id = the run id it launched as), committed atomically
 * with the run's own principal/session/run rows. Every relaunch after a
 * terminal death re-points `currentRunId` while the stable id — the
 * address a delivery workbench's participant record holds — never moves.
 */
export function workbenchLaunchPersistExtra(input: {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly foldedBody: FoldedBody;
}): (tx: DBExecutor) => Promise<void> {
  return async (tx) => {
    await tx.insert(workbenchLaunch).values({
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      currentRunId: input.instanceId,
      foldedBody: input.foldedBody,
      createdAt: new Date(),
    });
  };
}
