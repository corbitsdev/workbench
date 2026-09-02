// Turns a picked workbench definition into the state a freshly minted
// workbench needs: the agent definitions that don't already exist, the
// block workflows behind them, the still-pending plugin list the room
// persists, and the definition's ordered onboarding walkthrough handed
// to whatever surface runs it. Pure orchestration over injected ports —
// no HTTP, no store — so a host (today, `apps/web`'s
// `instant-agent-create.ts`) can bind the ports to its own REST clients
// and this stays testable with plain fakes.
//
// This resolves a definition whose non-Myra agents are backed by either
// `@corbits/code-review`'s reviewer roster (`CODE_REVIEW_TEMPLATE`) or a
// standalone chat agent this catalog installs the same way — Scout, for
// `DUE_DILIGENCE_TEMPLATE` (see `./participant-agent-requests.ts`).
// Jimmy resolves through the identical `ParticipantAgentRequest` shape
// (`jimmyAgentRequest()`), but no shipped definition names his handle
// today — he is not a "kind of workbench"; `@corbits/chat-ui`'s "Add
// Jimmy" quick-create row calls `jimmyAgentRequest()` directly instead.
// Kept registered here too so a future definition naming his handle
// resolves without new plumbing.
//
// A definition like `GTM_TEMPLATE`, whose agents are backed by their own
// deployed workflow definitions rather than an agent-directory create
// request, needs its own resolution path — calling this function against
// such a definition throws rather than silently doing nothing.
import {
  codeReviewAgentRequests,
  type CodeReviewAgentRequest,
} from "@corbits/code-review/agent-requests";
import {
  jimmyAgentRequest,
  scoutAgentRequest,
} from "./participant-agent-requests";

import type {
  WorkbenchDefinition,
  WorkbenchOnboardingStep,
  WorkbenchTemplateBlock,
} from "./index";

/** The agent-directory create-request shape every agent resolves
 * to: `CodeReviewAgentRequest`'s own fields, plus the tool-package pins
 * a tool-calling agent (Scout, Jimmy) needs and a pure-text
 * reviewer does not. */
export type ParticipantAgentRequest = CodeReviewAgentRequest & {
  readonly toolPackagePins?: readonly string[];
};

export interface WorkbenchTemplateInstantiationPorts {
  /** Every agent definition already deployed in the bench, as
   * `{handle, id}` pairs. Doubles as the idempotency check (re-running
   * instantiation — a retried create, a second workbench from the same
   * template — never double-creates a reviewer) and as the id source
   * for `inviteParticipantAgent` below: an agent definition the tenant
   * already has is not yet a member of a freshly minted room, so
   * its id still has to reach the invite call even when this function
   * skips creating it. */
  listAgentHandles(): Promise<
    readonly { readonly handle: string; readonly id: string }[]
  >;
  /** The agent-directory create path (`POST /agent-definitions`), or a
   * fake of it in tests. */
  createParticipantAgent(
    request: ParticipantAgentRequest,
  ): Promise<{ readonly id: string }>;
  /** Deploys one of the definition's referenced block workflows through
   * the same source-form deploy the agent definitions use
   * (`POST /template-blocks/:assetName/deploy` — see
   * `./template-block-routes.ts`), or a fake of it in tests. `created`
   * is `false` when the tenant already carries a deployed definition
   * under this asset name, so a retried instantiation never
   * double-deploys. */
  deployBlockWorkflow(
    block: WorkbenchTemplateBlock,
  ): Promise<{ readonly created: boolean }>;
  /** Adds one agent definition to the newly created
   * workbench's room (`POST /workbenches/:id/invite` —
   * `@corbits/chat-ui`'s `inviteAgent`), or a fake of it in tests. This
   * is what makes a definition's roster actually present in the room
   * rather than merely registered in the agent directory. Called for
   * Myra too: she is an existing principal invited after mint, not
   * the room's host `definitionId`. */
  inviteParticipantAgent(id: string): Promise<void>;
  /** Persists the room's still-needed connections — the workbench
   * settings `template/pendingConnections` key today; see
   * `apps/web/src/instant-agent-create.ts`. */
  recordPendingConnections(
    pendingConnections: readonly string[],
  ): Promise<void>;
  /** Runs the definition's onboarding walkthrough in the freshly minted
   * room — `apps/web` posts the first step's card through
   * `postWorkbenchOnboardingStep`. Called last, and only when the
   * definition has steps at all. */
  beginOnboarding(steps: readonly WorkbenchOnboardingStep[]): Promise<void>;
}

export interface WorkbenchTemplateInstantiationResult {
  readonly createdHandles: readonly string[];
  readonly skippedHandles: readonly string[];
  /** Every non-Myra agent handle actually added to the room —
   * `createdHandles` and `skippedHandles` combined, in definition order.
   * A caller proving the roster a definition promises is really present
   * checks this, not just that the definitions exist. */
  readonly invitedHandles: readonly string[];
  /** Block workflows `deployBlockWorkflow` actually deployed on this
   * run, by asset name; a block the tenant already carried lands in
   * `skippedBlockAssetNames` instead. */
  readonly deployedBlockAssetNames: readonly string[];
  readonly skippedBlockAssetNames: readonly string[];
  readonly pendingConnections: readonly string[];
  /** The ordered walkthrough handed to `beginOnboarding` — empty for a
   * definition with no onboarding at all. */
  readonly onboardingSteps: readonly WorkbenchOnboardingStep[];
}

/**
 * Resolves `definition` against the bench: creates the agent
 * definitions that don't already exist (Myra is never re-created — she
 * is the bench's seeded default setup agent, reused as-is and invited
 * into the new channel), records the definition's required plugins as
 * still pending, and then begins its onboarding walkthrough. Never
 * registers a live webhook trigger itself: that is what the
 * walkthrough's own start-reviewing step does, once the person has
 * picked repos.
 */
export async function instantiateWorkbenchTemplate(
  definition: WorkbenchDefinition,
  ports: WorkbenchTemplateInstantiationPorts,
): Promise<WorkbenchTemplateInstantiationResult> {
  const existingIdsByHandle = new Map(
    (await ports.listAgentHandles()).map((agent) => [agent.handle, agent.id]),
  );
  const assistantId = existingIdsByHandle.get("assistant");
  if (assistantId !== undefined && !existingIdsByHandle.has("myra")) {
    existingIdsByHandle.set("myra", assistantId);
  }
  const requestsByHandle = new Map<string, ParticipantAgentRequest>(
    [
      ...codeReviewAgentRequests(),
      scoutAgentRequest(),
      jimmyAgentRequest(),
    ].map((request) => [request.handle, request]),
  );

  // The definition's referenced block workflows deploy first: an agent
  // is a lens over a block, and the connect card's
  // start-reviewing step resolves the deployed block definition by
  // name, so a bench must never end up with reviewers but no
  // `code-review` workflow behind them.
  const deployedBlockAssetNames: string[] = [];
  const skippedBlockAssetNames: string[] = [];
  for (const block of definition.blocks) {
    const outcome = await ports.deployBlockWorkflow(block);
    (outcome.created ? deployedBlockAssetNames : skippedBlockAssetNames).push(
      block.assetName,
    );
  }

  const createdHandles: string[] = [];
  const skippedHandles: string[] = [];
  const invitedHandles: string[] = [];
  for (const agent of definition.agents) {
    const existingId = existingIdsByHandle.get(agent.handle);
    let agentId: string;
    if (existingId !== undefined) {
      skippedHandles.push(agent.handle);
      agentId = existingId;
    } else if (agent.handle === "myra") {
      // Seeded principal (`name: "assistant"`), never minted from a
      // definition's roster. The create path already gates on
      // `findMyraDefinition`; skip rather than throw.
      continue;
    } else {
      const request = requestsByHandle.get(agent.handle);
      if (request === undefined) {
        throw new Error(
          `workbench definition "${definition.id}" agent "${agent.handle}" ` +
            "has no known create-agent request to instantiate it from",
        );
      }
      const created = await ports.createParticipantAgent(request);
      createdHandles.push(agent.handle);
      agentId = created.id;
    }
    await ports.inviteParticipantAgent(agentId);
    invitedHandles.push(agent.handle);
  }

  await ports.recordPendingConnections(definition.plugins.required);

  if (definition.onboardingSteps.length > 0) {
    await ports.beginOnboarding(definition.onboardingSteps);
  }

  return {
    createdHandles,
    skippedHandles,
    invitedHandles,
    deployedBlockAssetNames,
    skippedBlockAssetNames,
    pendingConnections: definition.plugins.required,
    onboardingSteps: definition.onboardingSteps,
  };
}
