// Every "create a workbench" affordance — the sidebar's "+", the command
// palette's "New workbench", and the zero-workbench land-hop on `/` —
// opens the picker (`pages/new-workbench-picker.tsx`) and calls
// `createWorkbench` below once a person hits Create. CL-8156 deleted
// workbench template picking (`@workbench/templates`): a new workbench is
// a plain tenant + Myra now (CL-8154's converge path deploys Myra), so
// this mints an empty `kind: "workbench"` channel — no host, no
// definitionId — and, when the prompt box supplied an opening message,
// sends it and renames the room off it. Explicitly defining a brand-new
// agent, with its own name/purpose/model/skills chosen up front, stays
// `CreateAgentPanel`'s job (Settings → Agents), unchanged.

import type { QueryClient } from "@tanstack/react-query";
import {
  createWorkbench as createWorkbenchChannel,
  inviteAgent,
  partsForSend,
  patchWorkbenchSettings,
  sendMessage,
  workbenchesQueryKeyPrefix,
} from "@corbits/chat-ui";
import { reportError } from "@corbits/error-sink";

import { listAgentDefinitions } from "./agents-api";
import { autoNameFromFirstMessage, NEW_WORKBENCH_TITLE } from "./auto-workbench-title";
import { findMyraDefinition } from "./myra-workbench";
import { workbenchPath } from "./workbench-path";

export { NEW_WORKBENCH_TITLE };

export function refreshWorkbenchLists(
  queryClient: QueryClient,
  tenantId: string,
  workbenchId: string,
): void {
  void queryClient
    .invalidateQueries({
      queryKey: workbenchesQueryKeyPrefix(tenantId),
    })
    .catch((cause) => {
      reportError(cause, {
        operation: "refresh_workbench_lists",
        tenantId,
        roomId: workbenchId,
      });
    });
}

/**
 * Marks the bench-not-ready precondition below as intentionally
 * user-facing: its `message` is authored copy, never a raw request path
 * or schema summary, so a caller can show it verbatim. Every other throw
 * on this path (`ApiQueryError`, `ChatApiError`, or a plain `Error` from a
 * package that hasn't opted in) must go through that error type's own
 * describer instead — allow-listing safe throws, rather than denylisting
 * unsafe ones, so a new error type added later fails safe (masked)
 * instead of leaking by default.
 */
export class WorkbenchPreconditionError extends Error {
  readonly kind: "setup-agent-missing";
  constructor(message: string, kind: "setup-agent-missing") {
    super(message);
    this.kind = kind;
  }
}

export class WorkbenchPostCreateError extends Error {
  constructor(
    readonly workbenchId: string,
    readonly stage: "opening-message" | "rename",
    cause: unknown,
  ) {
    super("The workbench was created, but setup did not finish.", { cause });
  }
}

/**
 * Consumer-language stand-in for the system precondition this bench
 * hit: "no deployed setup agent" describes an internal implementation
 * detail, never something a person signing in for the first time
 * should have to parse.
 */
const SETUP_AGENT_MISSING_MESSAGE =
  "Your workbench is still finishing setup. Try again in a moment.";

/**
 * The picker's "Create workbench" action: mints an empty `kind:
 * "workbench"` channel with no host and no `definitionId`. Talking to an
 * agent is clicking that agent (find-or-reopen its one DM); this function
 * is the create verb for a room.
 *
 * The bench has to be past setup — its default Myra definition deployed —
 * before a room can invite anyone into it, so a bench that isn't fails
 * with `WorkbenchPreconditionError` rather than minting a room nobody can
 * join.
 *
 * `queryClient` invalidates the workbenches list once every selected
 * agent has been invited — `ChatWorkspace`'s own in-room "Invite agent"
 * dialog does the same (`workbenchesQueryKeyPrefix`,
 * `chat-workspace.tsx`'s `refreshWorkbenchLists`) so the room the invite
 * landed in never shows a participant it already has data for as if it
 * never joined. Without this, the room this function `navigate`s to can
 * start life holding a `workbenches` query cached from before the last
 * invite resolved.
 *
 * `firstMessage`, when given (the picker's prompt box), is sent as the
 * signed-in person's own opening message once the room exists, and
 * renames the room off `NEW_WORKBENCH_TITLE` via `patchWorkbenchSettings`
 * (`chat/name`), matching the sidebar rename path.
 */
export async function createWorkbench(
  tenantId: string,
  navigate: (to: string) => void,
  queryClient: QueryClient,
  firstMessage?: string,
  selectedAgentDefinitionIds: readonly string[] = [],
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  if (findMyraDefinition(definitions) === undefined) {
    throw new WorkbenchPreconditionError(SETUP_AGENT_MISSING_MESSAGE, "setup-agent-missing");
  }
  const workbench = await createWorkbenchChannel(tenantId, {
    kind: "workbench",
    name: NEW_WORKBENCH_TITLE,
  });

  if (firstMessage !== undefined && firstMessage.trim() !== "") {
    const selectedAgentInvites = [...new Set(selectedAgentDefinitionIds)].map((definitionId) => ({
      kind: "agent" as const,
      definitionId,
    }));
    try {
      await sendMessage(tenantId, workbench.id, partsForSend(firstMessage, []), {
        ...(selectedAgentInvites.length > 0 ? { invite: selectedAgentInvites } : {}),
      });
    } catch (cause) {
      throw new WorkbenchPostCreateError(workbench.id, "opening-message", cause);
    }
    // Blank / ad-hoc mints stay "New Workbench" until named. When the
    // prompt box already supplied the opening message, rename via the same
    // `chat/name` settings PATCH the sidebar rename uses.
    const autoTitle = autoNameFromFirstMessage(workbench.title, firstMessage);
    if (autoTitle !== undefined) {
      try {
        await patchWorkbenchSettings(tenantId, workbench.id, {
          "chat/name": autoTitle,
        });
      } catch (cause) {
        throw new WorkbenchPostCreateError(workbench.id, "rename", cause);
      }
      refreshWorkbenchLists(queryClient, tenantId, workbench.id);
    }
  } else if (selectedAgentDefinitionIds.length > 0) {
    for (const definitionId of new Set(selectedAgentDefinitionIds)) {
      await inviteAgent(tenantId, workbench.id, definitionId);
    }
  }

  refreshWorkbenchLists(queryClient, tenantId, workbench.id);
  navigate(workbenchPath(workbench.id));
}
