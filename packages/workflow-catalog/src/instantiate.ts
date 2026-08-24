// Turns a picked template into the state a freshly minted workbench
// needs: the participant agent definitions that don't already exist,
// and the required-connections list the room persists so the inline
// connect card (CL-6344's next slice) knows what to ask for. Pure
// orchestration over injected ports — no HTTP, no store — so a host
// (today, `apps/web`'s `instant-agent-create.ts`) can bind the ports to
// its own REST clients and this stays testable with plain fakes.
//
// This resolves a manifest whose non-Myra participants are backed by
// either `@corbits/code-review`'s reviewer roster (CL-6344's
// `CODE_REVIEW_TEMPLATE`) or a standalone chat agent this catalog installs
// the same way — Scout, for `DUE_DILIGENCE_TEMPLATE` (see
// `./participant-agent-requests.ts`). Jimmy resolves through the identical
// `ParticipantAgentRequest` shape (`jimmyAgentRequest()`), but CL-6499
// dropped his template — he is not a "kind of workbench" — so no shipped
// manifest names his handle today; `@corbits/chat-ui`'s "Add Jimmy"
// quick-create row calls `jimmyAgentRequest()` directly instead. Kept
// registered here too so a future template naming his handle resolves
// without new plumbing.
// A template like `GTM_TEMPLATE`, whose participants are backed by their
// own deployed workflow definitions rather than an agent-directory
// create request, needs its own resolution path — a later ticket, not
// this one; calling this function against such a manifest throws rather
// than silently doing nothing.
import {
  codeReviewAgentRequests,
  type CodeReviewAgentRequest,
} from "@corbits/code-review/agent-requests";
import {
  jimmyAgentRequest,
  scoutAgentRequest,
} from "./participant-agent-requests";

import type {
  WorkbenchTemplateBlock,
  WorkbenchTemplateManifest,
} from "./templates";

/** The agent-directory create-request shape every participant resolves
 * to: `CodeReviewAgentRequest`'s own fields, plus the tool-package pins
 * a tool-calling participant (Scout, Jimmy) needs and a pure-text
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
   * already has is not yet a participant of a freshly minted room, so
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
  /** Deploys one of the manifest's referenced block workflows through
   * the same source-form deploy the participant agents use
   * (`POST /template-blocks/:assetName/deploy` — see
   * `./template-block-routes.ts`), or a fake of it in tests. `created`
   * is `false` when the tenant already carries a deployed definition
   * under this asset name, so a retried instantiation never
   * double-deploys. */
  deployBlockWorkflow(
    block: WorkbenchTemplateBlock,
  ): Promise<{ readonly created: boolean }>;
  /** Adds one participant's agent definition to the newly created
   * workbench's room (`POST /workbenches/:id/invite` —
   * `@corbits/chat-ui`'s `inviteAgent`), or a fake of it in tests. This
   * is what makes a template's roster actually present in the room
   * rather than merely registered in the agent directory. Never called
   * for Myra: the host invites her separately after minting the room
   * (CL-6981 — she must not be the mint `definitionId`, which would
   * find-or-reopen her one agent conversation). */
  inviteParticipantAgent(id: string): Promise<void>;
  /** Persists the room's still-needed connections — the workbench
   * settings `template/pendingConnections` key today; see
   * `apps/web/src/instant-agent-create.ts`. */
  recordPendingConnections(
    pendingConnections: readonly string[],
  ): Promise<void>;
}

export interface WorkbenchTemplateInstantiationResult {
  readonly createdHandles: readonly string[];
  readonly skippedHandles: readonly string[];
  /** Every non-Myra participant handle actually added to the room —
   * `createdHandles` and `skippedHandles` combined, in manifest order.
   * A caller proving the roster a template's greeting promises is
   * really present checks this, not just that the definitions exist. */
  readonly invitedHandles: readonly string[];
  /** Block workflows `deployBlockWorkflow` actually deployed on this
   * run, by asset name; a block the tenant already carried lands in
   * `skippedBlockAssetNames` instead. */
  readonly deployedBlockAssetNames: readonly string[];
  readonly skippedBlockAssetNames: readonly string[];
  readonly pendingConnections: readonly string[];
  /**
   * One line per webhook trigger this template names, honestly stating
   * that no live `webhook_trigger` row exists yet — resolved by
   * `./connect-github-setup.ts`'s `startReviewingRepos` once the person
   * has picked repos on the connect card, not by this function. Never a
   * silent stub: a caller surfacing these tells the person setup isn't
   * done rather than pretending it is.
   */
  readonly webhookTriggerTodos: readonly string[];
}

function webhookTriggerTodo(
  manifest: WorkbenchTemplateManifest,
  trigger: WorkbenchTemplateManifest["webhookTriggers"][number],
): string {
  return (
    `pending: the live webhook_trigger row for "${manifest.id}"'s ` +
    `"${trigger.key}" trigger is created once the person picks repos on the ` +
    "room's GitHub connect card — see `./connect-github-setup.ts`'s " +
    "`startReviewingRepos` (CL-6345), which this manifest-resolution step " +
    "has no repo to hand off to yet."
  );
}

/**
 * Resolves `manifest` against the bench: creates the participant agent
 * definitions that don't already exist (Myra is never re-created — she
 * is the bench's seeded default setup agent, reused as-is), and
 * records the manifest's required connections as still pending. Never
 * registers a live webhook trigger — see `webhookTriggerTodos` and
 * `./connect-github-setup.ts`, which is what actually creates one, once
 * the person has picked repos.
 */
export async function instantiateWorkbenchTemplate(
  manifest: WorkbenchTemplateManifest,
  ports: WorkbenchTemplateInstantiationPorts,
): Promise<WorkbenchTemplateInstantiationResult> {
  const existingIdsByHandle = new Map(
    (await ports.listAgentHandles()).map((agent) => [agent.handle, agent.id]),
  );
  const requestsByHandle = new Map<string, ParticipantAgentRequest>(
    [
      ...codeReviewAgentRequests(),
      scoutAgentRequest(),
      jimmyAgentRequest(),
    ].map((request) => [request.handle, request]),
  );

  // The manifest's referenced block workflows deploy first: a
  // participant is a lens over a block, and the connect card's
  // start-reviewing step resolves the deployed block definition by
  // name, so a bench must never end up with reviewers but no
  // `code-review` workflow behind them.
  const deployedBlockAssetNames: string[] = [];
  const skippedBlockAssetNames: string[] = [];
  for (const block of manifest.blocks) {
    const outcome = await ports.deployBlockWorkflow(block);
    (outcome.created ? deployedBlockAssetNames : skippedBlockAssetNames).push(
      block.assetName,
    );
  }

  const createdHandles: string[] = [];
  const skippedHandles: string[] = [];
  const invitedHandles: string[] = [];
  for (const participant of manifest.participants) {
    if (participant.handle === "myra") continue;
    const existingId = existingIdsByHandle.get(participant.handle);
    let participantId: string;
    if (existingId !== undefined) {
      skippedHandles.push(participant.handle);
      participantId = existingId;
    } else {
      const request = requestsByHandle.get(participant.handle);
      if (request === undefined) {
        throw new Error(
          `workbench template "${manifest.id}" participant "${participant.handle}" ` +
            "has no known create-agent request to instantiate it from",
        );
      }
      const created = await ports.createParticipantAgent(request);
      createdHandles.push(participant.handle);
      participantId = created.id;
    }
    await ports.inviteParticipantAgent(participantId);
    invitedHandles.push(participant.handle);
  }

  await ports.recordPendingConnections(manifest.requiredConnections);

  return {
    createdHandles,
    skippedHandles,
    invitedHandles,
    deployedBlockAssetNames,
    skippedBlockAssetNames,
    pendingConnections: manifest.requiredConnections,
    webhookTriggerTodos: manifest.webhookTriggers.map((trigger) =>
      webhookTriggerTodo(manifest, trigger),
    ),
  };
}
