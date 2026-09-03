// Every "create a workbench" affordance — the sidebar's "+", the command
// palette's "New workbench", and the zero-workbench land-hop on `/` —
// opens the template picker (`pages/new-workbench-picker.tsx`) and calls
// `createWorkbenchFromTemplate` below once a row is chosen. Blank `+`
// mints an empty `kind: "workbench"` channel (no host, no definitionId).
// A named workbench definition mints that same empty channel, then
// instantiates what the definition describes — its agents, its block
// workflows, its pending plugins — and runs the definition's own
// onboarding walkthrough in the room. Explicitly defining a brand-new
// agent, with its own name/purpose/model/skills chosen up front, stays
// `CreateAgentPanel`'s job (Settings → Agents), unchanged.

import type { QueryClient } from "@tanstack/react-query";
import {
  createWorkbench,
  inviteAgent,
  partsForSend,
  patchWorkbenchSettings,
  postWorkbenchOnboardingStep,
  sendMessage,
  workbenchesQueryKeyPrefix,
} from "@corbits/chat-ui";
import {
  instantiateWorkbenchTemplate,
  templateSettingsPatch,
  type WorkbenchDefinition,
  type WorkbenchOnboardingStep,
} from "@workbench/templates";

import {
  deployWorkbenchTemplateBlock,
  fetchWorkbenchTemplateManifest,
} from "./workbench-templates-api";

import { createAgentDefinition, listAgentDefinitions } from "./agents-api";
import {
  autoNameFromFirstMessage,
  NEW_WORKBENCH_TITLE,
} from "./auto-workbench-title";
import { findMyraDefinition } from "./myra-workbench";
import { workbenchPath } from "./workbench-path";

import type { WorkbenchTemplateId } from "./workbench-templates";

export { NEW_WORKBENCH_TITLE };

/**
 * Marks the two precondition failures below as intentionally
 * user-facing: their `message` is authored copy, never a raw request
 * path or schema summary, so a caller can show it verbatim. Every
 * other throw on this path (`ApiQueryError`, `ChatApiError`, or a
 * plain `Error` from a package that hasn't opted in) must go through
 * that error type's own describer instead — allow-listing safe
 * throws, rather than denylisting unsafe ones, so a new error type
 * added later fails safe (masked) instead of leaking by default.
 *
 * `kind` lets a caller tell "the setup agent isn't deployed yet" apart
 * from "this template genuinely doesn't exist here" without parsing
 * `message` text: the first is very often a still-provisioning bench
 * (CL-6457's background deploy hasn't finished, or never started
 * without a credential) that the caller should check
 * `fetchAgentReadiness` over before treating as a dead end; the second
 * never resolves itself and should surface as-is.
 */
export class WorkbenchPreconditionError extends Error {
  readonly kind: "setup-agent-missing" | "template-unavailable";
  constructor(
    message: string,
    kind: "setup-agent-missing" | "template-unavailable",
  ) {
    super(message);
    this.kind = kind;
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
 * Raises the walkthrough's first card in the room. Only a
 * `connect-plugin github` step has an in-room card today; the steps
 * after it (`pick-github-repos`, `start-webhook-trigger`) are driven by
 * that same card as the person works through it, so they need no client
 * action here. The whole ordered walkthrough rides along in the card's
 * body, so its step rail renders the definition's own copy.
 */
async function postOnboardingWalkthrough(
  tenantId: string,
  workbenchId: string,
  definition: WorkbenchDefinition,
  steps: readonly WorkbenchOnboardingStep[],
): Promise<void> {
  const labels = steps.map(({ title, why }) => ({ title, why }));
  for (const step of steps) {
    if (step.kind !== "connect-plugin") continue;
    if (step.connectorId !== "github") {
      throw new Error(
        `workbench template "${definition.id}" asks to connect ` +
          `"${step.connectorId}", which has no in-room onboarding card yet`,
      );
    }
    await postWorkbenchOnboardingStep(tenantId, workbenchId, {
      kind: "connect-github",
      requiredForTemplate: definition.title,
      promise: definition.promise,
      steps: labels,
    });
  }
}

/**
 * The template picker's "Create workbench" action: mints an empty
 * `kind: "workbench"` channel with no host and no `definitionId`, then
 * instantiates the picked definition into it — its agents (existing
 * principals invited after mint, new ones created first), its block
 * workflows, its pending plugins — and posts the first step of the
 * definition's onboarding walkthrough as a card in the room. Talking to
 * an agent is clicking that agent (find-or-reopen its one DM); this
 * function is the create verb for a room.
 *
 * The bench has to be past setup — its default assistant definition
 * deployed — before a room can invite anyone into it, so a bench that
 * isn't fails with `WorkbenchPreconditionError` rather than minting a
 * room nobody can join. That definition is the readiness gate only: no
 * definition names it as a host, and none invites it. A template id
 * with no definition (`blank`, "Just start talking") mints a plain
 * untagged channel under the generic `NEW_WORKBENCH_TITLE`.
 *
 * `queryClient` invalidates the workbenches list once every agent the
 * definition names has been invited — `ChatWorkspace`'s own
 * in-room "Invite agent" dialog does the same
 * (`workbenchesQueryKeyPrefix`, `chat-workspace.tsx`'s
 * `refreshWorkbenchLists`) so the room the invite landed in never
 * shows a participant it already has data for as if it never joined.
 * Without this, the room this function `navigate`s to can start life
 * holding a `workbenches` query cached from before the last invite
 * resolved.
 *
 * `firstMessage`, when given (the picker's prompt box), is sent as the
 * signed-in person's own opening message once the room and the
 * definition's agents exist, so it lands after the onboarding card
 * rather than racing it. For a blank / ad-hoc mint that same text also
 * renames the room off `NEW_WORKBENCH_TITLE` via
 * `patchWorkbenchSettings` (`chat/name`), matching the sidebar rename
 * path; prefab titles are left alone.
 */
export async function createWorkbenchFromTemplate(
  tenantId: string,
  templateId: WorkbenchTemplateId,
  navigate: (to: string) => void,
  queryClient: QueryClient,
  firstMessage?: string,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const setupTemplate = findMyraDefinition(definitions);
  if (setupTemplate === undefined) {
    throw new WorkbenchPreconditionError(
      SETUP_AGENT_MISSING_MESSAGE,
      "setup-agent-missing",
    );
  }
  // The definition comes from the bench library, never from a
  // hardcoded catalog import; reading it is what seeds the shelf.
  // `blank` is the one id with no definition by design; any
  // other id resolving to nothing means this build ships no such
  // template — fail loud rather than mint a workbench missing its
  // agents. The picker only offers ids the library listed, so this is
  // the race-loser's message, not the everyday path.
  const definition =
    templateId === "blank"
      ? undefined
      : ((await fetchWorkbenchTemplateManifest(tenantId, templateId)) ??
        undefined);
  if (templateId !== "blank" && definition === undefined) {
    throw new WorkbenchPreconditionError(
      `A ${templateId} workbench isn't available here yet.`,
      "template-unavailable",
    );
  }
  const workbench = await createWorkbench(tenantId, {
    kind: "workbench",
    name: definition?.title ?? NEW_WORKBENCH_TITLE,
  });

  if (definition !== undefined) {
    await instantiateWorkbenchTemplate(definition, {
      async listAgentHandles() {
        const current = await listAgentDefinitions(tenantId);
        return current.map((definition) => ({
          handle: definition.name,
          id: definition.id,
        }));
      },
      async createParticipantAgent(request) {
        const created = await createAgentDefinition(tenantId, request);
        return { id: created.id };
      },
      async deployBlockWorkflow(block) {
        return deployWorkbenchTemplateBlock(tenantId, block.assetName);
      },
      async inviteParticipantAgent(id) {
        await inviteAgent(tenantId, workbench.id, id);
      },
      async recordPendingConnections(pendingConnections) {
        await patchWorkbenchSettings(
          tenantId,
          workbench.id,
          templateSettingsPatch(definition.id, pendingConnections),
        );
      },
      async beginOnboarding(steps) {
        await postOnboardingWalkthrough(
          tenantId,
          workbench.id,
          definition,
          steps,
        );
      },
    });
    await queryClient.invalidateQueries({
      queryKey: workbenchesQueryKeyPrefix(tenantId),
    });
  }

  if (firstMessage !== undefined && firstMessage.trim() !== "") {
    await sendMessage(tenantId, workbench.id, partsForSend(firstMessage, []));
    // Blank / ad-hoc mints stay "New Workbench" until named. When the
    // prompt box already supplied the opening message, rename via the same
    // `chat/name` settings PATCH the sidebar rename uses — prefab titles
    // (`definition?.title`) are left alone by `autoNameFromFirstMessage`.
    const autoTitle = autoNameFromFirstMessage(workbench.title, firstMessage);
    if (autoTitle !== undefined) {
      await patchWorkbenchSettings(tenantId, workbench.id, {
        "chat/name": autoTitle,
      });
      await queryClient.invalidateQueries({
        queryKey: workbenchesQueryKeyPrefix(tenantId),
      });
    }
  }

  navigate(workbenchPath(workbench.id));
}
