// Workbench-level orchestration that sits above the platform port:
// joining an agent into a workbench (shared by chat creation and
// `POST .../invite`), sending a message with its full mention fan-out
// — recipient resolution, prior-context loading, and the per-recipient
// delivery loop — and provisioning a bare new space workbench for a
// caller (like a routine) that names no existing destination. Each
// depends only on the platform/store seams it actually calls, not the
// full `ChatPlatform`/`ChatStore`.
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { InferenceResolutionError } from "@corbits/folded-runs";
import { encodeParts } from "./codec";
import type { Part as PartType } from "./parts";
import { localPartOf } from "./agent-address";
import { isAgentAddress, mentionedParticipants } from "./mentions";
import { mergeContextIntoParts } from "./workbench-context";
import {
  assembleTurnContext,
  type TurnContextThreadScope,
} from "./turn-context";
import type { AgentTurnStore } from "./agent-turns";
import type { ThreadStore } from "./threads";
import {
  addParticipant,
  handleFromName,
  removeParticipant,
  type ParticipantRecord,
} from "./participants";
import {
  benchContextWindowOf,
  participantsOf,
  resolveContextWindow,
} from "./workbench-settings";
import { presetForKind } from "./kinds";
import type {
  WorkbenchLauncher,
  WorkbenchMail,
  ChatWorkbenchEvent,
  InvitableDefinition,
} from "./platform-port";
import { postRoomMessage, type RoomMessageStore } from "./room-messages";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";
import type { QueuedTurn, WorkbenchTurnQueue } from "./turn-queue";
import type { WorkbenchTenancyStore } from "./workbench-tenancy";
import type { ChatStore } from "./store";

const provisionLog = getLogger(["chat", "provision-space"]);
const removeLog = getLogger(["chat", "remove-participant"]);
const greetingLog = getLogger(["chat", "canned-greeting"]);
const fanoutLog = getLogger(["chat", "message-fanout"]);

export type ProvisionSpaceWorkbenchDeps = {
  readonly tenancy: Pick<
    WorkbenchTenancyStore,
    "createWorkbenchTenant" | "compensateWorkbenchTenant"
  >;
  readonly store: Pick<ChatStore, "createWorkbenchSettings">;
};

export type ProvisionSpaceWorkbenchInput = {
  readonly tenantId: string;
  readonly tenantDomain: string;
  readonly creatorPrincipalId: string;
  readonly creatorUserId: string;
  readonly name: string;
};

export type ProvisionSpaceWorkbenchResult = {
  readonly workbenchId: string;
  readonly compensate: () => Promise<void>;
};

/**
 * Provisions a brand-new `kind: "workbench"` space (mint the child
 * tenant, write its base settings), the same steps `POST /workbenches`
 * runs for a named space — used by a caller (a routine's create route,
 * chiefly) that needs to hand a fresh destination to something else in
 * the same request rather than collecting one from a picker first. A
 * workbench is data: nothing launches or deploys here.
 *
 * Returns a `compensate` callback rather than compensating on every
 * failure itself: the caller may still fail its own next step (e.g.
 * writing the row this space is *for*) after this returns
 * successfully, and only the caller knows when that's happened.
 */
export async function provisionSpaceWorkbench(
  deps: ProvisionSpaceWorkbenchDeps,
  input: ProvisionSpaceWorkbenchInput,
): Promise<ProvisionSpaceWorkbenchResult> {
  const workbenchId = generateId("workflowRun");

  const workbenchTenant = await deps.tenancy.createWorkbenchTenant({
    parentTenantId: input.tenantId,
    workbenchId,
    name: input.name,
    creatorUserId: input.creatorUserId,
  });

  const preset = presetForKind("workbench");
  try {
    await deps.store.createWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId,
      settings: {
        "chat/kind": "workbench",
        "chat/pinned": preset.pinned,
        "chat/participants": [],
        "chat/name": input.name,
      },
      updatedBy: input.creatorPrincipalId,
    });
  } catch (err) {
    provisionLog.error(
      "Workbench settings write failed for {workbenchId} after minting " +
        "{tenantId}; compensating the orphaned tenant",
      { workbenchId, tenantId: workbenchTenant.tenantId, err },
    );
    try {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    } catch (compensationErr) {
      provisionLog.error(
        "Compensation failed for orphaned tenant {tenantId} after " +
          "workbench {workbenchId}'s settings failure; this tenant is now " +
          "a privileged orphan with no workbench pointing at it and " +
          "requires manual cleanup",
        { workbenchId, tenantId: workbenchTenant.tenantId, compensationErr },
      );
    }
    throw err;
  }

  return {
    workbenchId,
    compensate: async () => {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    },
  };
}

export type LaunchAndJoinAgentDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly platform: WorkbenchLauncher;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
};

export type LaunchAndJoinAgentInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly definitionId: string;
  readonly existingSettings: Record<string, unknown>;
  /**
   * The tenant's invitable listing, fetched once by the caller — every
   * call site already holds (or needs) it for its own resolution, so
   * this function never re-fetches the same listing behind the
   * caller's back.
   */
  readonly invitable: readonly InvitableDefinition[];
};

export type LaunchAndJoinAgentResult = {
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
  readonly settings: Record<string, unknown>;
  /**
   * Settles when the timeline's `workbench.agent-joined` event has been
   * delivered (or its failure logged — it never rejects). The send may
   * be the workbench host's first traffic, which deploys the host, so
   * it must never block the join itself; a caller that posts follow-up
   * mail (the canned greeting) chains on this to keep timeline order.
   */
  readonly joinEventDelivered: Promise<void>;
};

/**
 * The agent participant this room already holds for `definitionId`, or
 * undefined when none of the room's agents was launched from it. One
 * room participant = one live run (CL-6451): every path that could
 * start a definition in a room checks residency here first, so a
 * mention, a workflow command, or a repeated invite reaches the run the
 * room already has instead of minting a sibling. Identity is the
 * definition's ASSET when both sides resolve one (a code-sourced deploy
 * projects a fresh definition row per wire projection over the same
 * asset — see `resolveDefinitionAssetId`), falling back to row-id
 * equality when either side's asset is unresolvable.
 */
export async function findResidentAgentForDefinition(
  platform: Pick<
    WorkbenchLauncher,
    "resolveDefinitionIdByAddress" | "resolveDefinitionAssetId"
  >,
  participants: readonly ParticipantRecord[],
  definitionId: string,
): Promise<ParticipantRecord | undefined> {
  const assetId = await platform.resolveDefinitionAssetId(definitionId);
  for (const participant of participants) {
    if (!isAgentAddress(participant.address)) continue;
    const launchedFrom = await platform.resolveDefinitionIdByAddress(
      participant.address,
    );
    if (launchedFrom === undefined) continue;
    if (launchedFrom === definitionId) return participant;
    if (assetId === undefined) continue;
    const launchedFromAssetId =
      await platform.resolveDefinitionAssetId(launchedFrom);
    if (launchedFromAssetId === assetId) return participant;
  }
  return undefined;
}

/**
 * The invite core: launches the definition's own instance, derives
 * its friendly mention handle, appends the participant record, posts
 * the join event onto the workbench's timeline, and arms the reply
 * bridge. Shared by `POST .../invite` and chat creation (a chat's
 * single agent is invited exactly this way, at creation) so the two
 * paths can never drift.
 *
 * Always launches: an explicit invite deliberately CAN place a second
 * instance of one definition in a room (that is what handle
 * de-duplication — "echo", "echo-2" — exists for). "One room
 * participant = one live run" (CL-6451) is enforced where the sibling
 * was never asked for: the message pipeline's command intercept and
 * `startWorkflowCommand` resolve residency via
 * `findResidentAgentForDefinition` before ever reaching this launch.
 */
export async function launchAndJoinAgent(
  deps: LaunchAndJoinAgentDeps,
  input: LaunchAndJoinAgentInput,
): Promise<LaunchAndJoinAgentResult> {
  const launched = await deps.platform.launchInvite({
    tenantId: input.tenantId,
    creatorPrincipalId: input.principalId,
    definitionId: input.definitionId,
  });

  // The invited definition's human display name (`description`, e.g.
  // "Myra" for the `assistant` asset) becomes the friendly mention
  // handle, falling back to the asset name itself when the deploy
  // carried no display name, and to the invited run's own unusable
  // instance-id local part when the listing no longer carries the
  // definition at all. The asset name (`.name`) is a wire identifier,
  // never UI copy — it must never surface as a mention handle. Either
  // way it is de-duplicated against every handle already in the
  // workbench ("echo", "echo-2", ...).
  const invitedDefinition = input.invitable.find(
    (definition) => definition.id === input.definitionId,
  );
  const desiredHandle =
    invitedDefinition !== undefined
      ? handleFromName(
          invitedDefinition.description ?? invitedDefinition.name,
          launched.address,
        )
      : localPartOf(launched.address);

  // The record is updated before the join event is posted, matching
  // the settings PATCH route's record-then-mail ordering: the
  // participant list is the durable source of truth, so a failure
  // below never leaves it unwritten.
  const participants = participantsOf(input.existingSettings);
  const row = await deps.store.updateWorkbenchSettings({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    settings: {
      ...input.existingSettings,
      "chat/participants": addParticipant(
        participants,
        launched.address,
        desiredHandle,
      ),
    },
    updatedBy: input.principalId,
  });

  const joinEvent: PartType = {
    kind: "event",
    event: "workbench.agent-joined",
    data: {
      address: launched.address,
      definitionId: input.definitionId,
      invitedBy: input.principalId,
    },
  };
  // Not awaited: the participant record above is the durable source of
  // truth, and this send may be the host's first traffic — the wake it
  // triggers deploys the host, which must never put deploy time back
  // on the caller's path. A delivery failure is logged, never thrown.
  const joinEventDelivered = postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: launched.address },
    runId: localPartOf(launched.address),
    parts: [joinEvent],
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      greetingLog.error(
        "Join event post failed for workbench {workbenchId}'s agent " +
          "{address}; the participant record is durable, only the " +
          "timeline's joined line is missing: {err}",
        { workbenchId: input.workbenchId, address: launched.address, err },
      );
    });

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: launched.address,
    definitionId: input.definitionId,
    handle: desiredHandle,
    settings: row.settings,
    joinEventDelivered,
  };
}

export type PostCannedGreetingDeps = {
  readonly roomMessages: RoomMessageStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
};

export type CannedGreetingInput = {
  /** The chat's own workbench id — the seed that picks which greeting
   * variation this chat gets, so the same chat always renders the same
   * opener. */
  readonly workbenchId: string;
  /** The agent's display name ("Myra"), never its mention handle. */
  readonly agentName: string;
  /** The opener's display name, when the host can resolve one. */
  readonly senderName?: string;
  /**
   * The picked template's promise line (`WorkbenchTemplateManifest.promise`
   * — see `@corbits/workflow-catalog`), when this chat was minted from
   * one. Present, the opener names what the room is actually for
   * instead of a generic hello; absent, `GREETING_VARIATIONS` picks the
   * usual random opener.
   */
  readonly templatePromise?: string;
};

export type PostCannedGreetingInput = CannedGreetingInput & {
  readonly tenantId: string;
  readonly agentAddress: string;
};

/**
 * The opener variations. Canned rather than model-written so the
 * greeting is on the timeline the moment the agent joins — a fresh
 * chat used to stay silent through a whole kickoff inference turn, and
 * a person who typed into that silence wrong-footed the conversation.
 * Each takes the leading address (" Alice" or "") and the agent's
 * display name; none may mention the workbench's title (a label the
 * opener picked, never a request) or capabilities-as-a-menu.
 */
const GREETING_VARIATIONS: readonly ((who: string, agent: string) => string)[] =
  [
    (who, agent) =>
      `Hey${who} — good to have a space to work in together. I'm ${agent}, ` +
      "your teammate here; I can write, plan, pull pieces together, and " +
      "line up the specialists and automations when we need them. What " +
      "are you working on?",
    (who, agent) =>
      `Hi${who}, I'm ${agent} — your teammate here. Drafting, planning, ` +
      "research, lining up automations: all fair game. What should we " +
      "dig into first?",
    (who, agent) =>
      `Welcome in${who === "" ? "" : `,${who}`}. I'm ${agent}; think of me ` +
      "as the teammate who writes, plans, and pulls in the right " +
      "specialists when a job calls for them. What's on your plate?",
    (who, agent) =>
      `Hey${who} — ${agent} here. This space is ours to work in: I can ` +
      "draft, plan, and wire things up as we go. What are you working on?",
  ];

function greetingVariationIndex(workbenchId: string): number {
  let sum = 0;
  for (const character of workbenchId) {
    sum = (sum + (character.codePointAt(0) ?? 0)) % GREETING_VARIATIONS.length;
  }
  return sum;
}

/** The template-flavored opener: names the room's actual job (the
 * manifest's own `promise` line) instead of a generic hello, and asks
 * for the one thing every template needs before it can start —
 * something connected. */
function templateGreeting(who: string, agent: string, promise: string): string {
  return (
    `Hi${who}, I'm ${agent}. ${promise} Connect what I need and tell me ` +
    "what to watch, and I'll take it from there."
  );
}

export function cannedGreeting(input: CannedGreetingInput): string {
  const who =
    input.senderName !== undefined && input.senderName !== ""
      ? ` ${input.senderName}`
      : "";
  if (input.templatePromise !== undefined) {
    return templateGreeting(who, input.agentName, input.templatePromise);
  }
  const variation =
    GREETING_VARIATIONS[greetingVariationIndex(input.workbenchId)];
  if (variation === undefined) throw new Error("no greeting variations");
  return variation(who, input.agentName);
}

/**
 * Posts a newly-minted chat's opening greeting onto its timeline under
 * the joining agent's own name, so a fresh room is never silent until
 * a human speaks first. The text is canned (see `GREETING_VARIATIONS`)
 * and sent to the chat's own workbench id with the agent's run as
 * `fromWorkbenchId` — exactly how the orchestrator's `postReply`
 * attributes an agent's real replies — so no inference turn runs and
 * the greeting lands the moment the agent joins. The agent's own
 * system prompt tells it a canned opener was already posted under its
 * name, so its first real turn answers the person instead of greeting
 * again.
 *
 * Errors are logged, never thrown: the caller fires this after the
 * chat has already been minted successfully, and a greeting that
 * fails to post must never fail — or roll back — the mint itself.
 */
export async function postCannedGreeting(
  deps: PostCannedGreetingDeps,
  input: PostCannedGreetingInput,
): Promise<void> {
  try {
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      sender: { name: null, address: input.agentAddress },
      runId: localPartOf(input.agentAddress),
      parts: [{ kind: "text", text: cannedGreeting(input) }],
    });
  } catch (err) {
    greetingLog.error(
      "Canned greeting post failed for workbench {workbenchId}'s agent " +
        "{agentAddress}; the chat was minted successfully but stays " +
        "silent until a human sends the first message: {err}",
      { workbenchId: input.workbenchId, agentAddress: input.agentAddress, err },
    );
  }
}

export type JoinHumanParticipantDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
  readonly tenancy: Pick<WorkbenchTenancyStore, "addWorkbenchMember">;
};

export type JoinHumanParticipantInput = {
  readonly tenantId: string;
  /** The creator/inviter — whoever's action is causing the join, and
   * who `updateWorkbenchSettings` records as `updatedBy`. */
  readonly principalId: string;
  readonly workbenchId: string;
  /** The bench member being added as the chat's second participant —
   * already validated by the caller (see `routes.ts`'s create handler)
   * to name a real, active, non-self principal in this tenant. */
  readonly memberPrincipalId: string;
  /** The invited member's own auth identity (`principal.refId`) —
   * what `addWorkbenchMember` mints a member-role principal for in the
   * workbench's own child tenant (CL-6332), by construction carrying
   * that role's `room:*` read/write pair. Never `memberPrincipalId`
   * itself: that id is scoped to the acting/bench tenant, not the
   * workbench's own tenant a fresh principal is minted into. */
  readonly memberRefId: string;
  /** The participant record's `handle` — a human has no settings-held
   * name to derive one from the way an invited agent's definition
   * does, so the caller (the create route, which already has the
   * chosen member's display name from the request body) supplies it
   * directly. */
  readonly memberHandle: string;
  readonly existingSettings: Record<string, unknown>;
};

export type JoinHumanParticipantResult = {
  readonly address: string;
  readonly handle: string;
  readonly settings: Record<string, unknown>;
  /** See `LaunchAndJoinAgentResult`'s field of the same name. */
  readonly joinEventDelivered: Promise<void>;
};

/**
 * The human-counterpart analog of `launchAndJoinAgent`: adds a bench
 * member directly as a chat's second participant, with no instance to
 * launch — a human participant reads the workbench's own timeline
 * directly (see `mentions.ts`'s `isAgentAddress` note), so there is no
 * mailbox to stand up, only the participant record and an audit event
 * on the workbench's own timeline. The participant's `address` is the
 * bare principal id (no "@"), which is exactly what marks it as
 * non-agent everywhere else in the package (`isAgentAddress`,
 * `mentionedParticipants`, the DM sidebar bucket in the host app).
 */
export async function joinHumanParticipant(
  deps: JoinHumanParticipantDeps,
  input: JoinHumanParticipantInput,
): Promise<JoinHumanParticipantResult> {
  // Mints (or, for a repeat invite, confirms) the member-role principal
  // this workbench's own child tenant gates members-only access by —
  // see `workbench-tenancy.ts`'s `addWorkbenchMember`. Ahead of the
  // participant record: `chat/participants` is a mention handle only
  // (CL-6332), never itself the membership signal, so a failure here
  // must fail the whole invite rather than leave a participant record
  // with no membership behind it.
  await deps.tenancy.addWorkbenchMember({
    workbenchId: input.workbenchId,
    refId: input.memberRefId,
  });

  const participants = participantsOf(input.existingSettings);
  const row = await deps.store.updateWorkbenchSettings({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    settings: {
      ...input.existingSettings,
      "chat/participants": addParticipant(
        participants,
        input.memberPrincipalId,
        input.memberHandle,
      ),
    },
    updatedBy: input.principalId,
  });

  const joinEvent: PartType = {
    kind: "event",
    event: "workbench.member-joined",
    data: {
      principalId: input.memberPrincipalId,
      invitedBy: input.principalId,
    },
  };
  // Not awaited, for the same reason `launchAndJoinAgent`'s own join
  // event isn't: the participant record above is the durable source of
  // truth, and this send can carry the host's deploy.
  const joinEventDelivered = postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.principalId },
    senderPrincipalId: input.principalId,
    parts: [joinEvent],
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      greetingLog.error(
        "Member-joined event post failed for workbench {workbenchId}'s " +
          "member {memberPrincipalId}; the participant record is durable, " +
          "only the timeline's joined line is missing",
        {
          workbenchId: input.workbenchId,
          memberPrincipalId: input.memberPrincipalId,
          err,
        },
      );
    });

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: input.memberPrincipalId,
    handle: input.memberHandle,
    settings: row.settings,
    joinEventDelivered,
  };
}

export type RemoveWorkbenchParticipantDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
  /**
   * Releases an invited agent's launched instance the way the idle-sleep
   * lifecycle itself tears one down (`sidecarRouter.sendAgentUndeploy`
   * in the hub's own wiring — see `apps/hub/src/index.ts`'s
   * `chatDeps.releaseAgentInstance`) — never re-implemented here, since
   * undeploy is native platform machinery this package only calls.
   * Omitted, an agent participant's instance is left running: the
   * removal still proceeds (the participant record is the source of
   * truth for who a message fans out to, and a workbench with a stale
   * removed-but-still-deployed instance is far better than one stuck
   * mid-removal), but that gap is logged at error level so it is never
   * silent.
   */
  readonly releaseAgentInstance?:
    ((address: string, reason: string) => Promise<void>) | undefined;
};

export type RemoveWorkbenchParticipantInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly existingSettings: Record<string, unknown>;
  /** The participant being removed — already confirmed by the caller
   * (`routes.ts`'s DELETE handler) to actually be a member of this
   * workbench. */
  readonly participant: ParticipantRecord;
};

export type RemoveWorkbenchParticipantResult = {
  readonly settings: Record<string, unknown>;
};

/**
 * The removal counterpart to `launchAndJoinAgent`/`joinHumanParticipant`:
 * undoes exactly what either of those created. Drops the participant
 * record, posts a "left" event onto the workbench's own timeline (the
 * audit-trail mirror of the "joined" event each join path posts), and —
 * only for an agent participant — releases its launched instance
 * through `deps.releaseAgentInstance` so an agent removed from a
 * workbench is never left running with nothing routing messages to it.
 * A human participant has no instance to release (see
 * `joinHumanParticipant`'s own note: a human reads the workbench's own
 * timeline directly, with no mailbox of its own).
 */
export async function removeWorkbenchParticipant(
  deps: RemoveWorkbenchParticipantDeps,
  input: RemoveWorkbenchParticipantInput,
): Promise<RemoveWorkbenchParticipantResult> {
  const participants = participantsOf(input.existingSettings);
  const row = await deps.store.updateWorkbenchSettings({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    settings: {
      ...input.existingSettings,
      "chat/participants": removeParticipant(
        participants,
        input.participant.address,
      ),
    },
    updatedBy: input.principalId,
  });

  const isAgent = isAgentAddress(input.participant.address);
  const leaveEvent: PartType = isAgent
    ? {
        kind: "event",
        event: "workbench.agent-left",
        data: {
          address: input.participant.address,
          removedBy: input.principalId,
        },
      }
    : {
        kind: "event",
        event: "workbench.member-left",
        data: {
          principalId: input.participant.address,
          removedBy: input.principalId,
        },
      };
  await postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.principalId },
    senderPrincipalId: input.principalId,
    parts: [leaveEvent],
  });

  if (isAgent) {
    if (deps.releaseAgentInstance !== undefined) {
      try {
        await deps.releaseAgentInstance(
          input.participant.address,
          "participant-removed",
        );
      } catch (err) {
        removeLog.error(
          "Releasing {address}'s launched instance failed after it was " +
            "removed from workbench {workbenchId}; the participant record " +
            "is gone but the instance may still be running and requires " +
            "manual cleanup",
          {
            address: input.participant.address,
            workbenchId: input.workbenchId,
            err,
          },
        );
      }
    } else {
      removeLog.error(
        "No releaseAgentInstance wired for this deployment; {address} " +
          "was dropped from workbench {workbenchId}'s participants but its " +
          "launched instance was never released and may still be running",
        { address: input.participant.address, workbenchId: input.workbenchId },
      );
    }
  }

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return { settings: row.settings };
}

export type StartWorkflowCommandDeps = {
  readonly store: Pick<
    ChatStore,
    "getWorkbenchSettings" | "updateWorkbenchSettings"
  >;
  readonly platform: WorkbenchLauncher & Pick<WorkbenchMail, "sendMail">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
};

export type StartWorkflowCommandInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly definitionId: string;
  readonly args: string;
};

export type StartWorkflowCommandResult = {
  readonly handle: string;
  readonly address: string;
};

/**
 * The `WorkflowCommandDeps.startWorkflow` implementation `@corbits/chat`
 * gives `@corbits/commands`' workflow-command registrar: invites the
 * named definition into the workbench exactly as `POST .../invite` does
 * (`launchAndJoinAgent`, so the two paths can never drift), then, when
 * the invocation carried args, sends them as the newly-joined agent's
 * opening mail the same way a mention fan-out delivers a copy — from
 * the workbench's own address, so a reply lands back in the workbench's
 * mailbox. An empty invocation ("/echo" with nothing after it) still
 * starts the run, mirroring corbits-code's own workflow dispatch: no
 * args is "Continue.", not "nothing to do".
 *
 * One room participant = one live run (CL-6451): a command naming a
 * definition already resident in the room delivers into the existing
 * participant's run — the same anti-sibling rule the message
 * pipeline's `@name` intercept enforces — instead of launching again.
 * A deliberate second instance stays possible through the explicit
 * invite affordance, which always launches.
 */
export async function startWorkflowCommand(
  deps: StartWorkflowCommandDeps,
  input: StartWorkflowCommandInput,
): Promise<StartWorkflowCommandResult> {
  const existing = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  if (existing === undefined) {
    throw new Error(
      `No workbench "${input.workbenchId}" to start a workflow in`,
    );
  }

  const resident = await findResidentAgentForDefinition(
    deps.platform,
    participantsOf(existing.settings),
    input.definitionId,
  );
  if (resident !== undefined) {
    const text = input.args.trim() !== "" ? input.args.trim() : "Continue.";
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(resident.address),
      principalId: input.principalId,
      content: encodeParts([{ kind: "text", text }]),
      fromWorkbenchId: input.workbenchId,
    });
    return { handle: resident.handle, address: resident.address };
  }

  const joined = await launchAndJoinAgent(
    {
      store: deps.store,
      platform: deps.platform,
      roomMessages: deps.roomMessages,
      publish: deps.publish,
    },
    {
      tenantId: input.tenantId,
      principalId: input.principalId,
      workbenchId: input.workbenchId,
      definitionId: input.definitionId,
      existingSettings: existing.settings,
      invitable: await deps.platform.listInvitableDefinitions(input.tenantId),
    },
  );

  const openingText =
    input.args.trim() !== "" ? input.args.trim() : "Continue.";
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: localPartOf(joined.address),
    principalId: input.principalId,
    content: encodeParts([{ kind: "text", text: openingText }]),
    fromWorkbenchId: input.workbenchId,
  });

  return { handle: joined.handle, address: joined.address };
}

export type SendWorkbenchMessageDeps = {
  readonly store: Pick<ChatStore, "getWorkbenchSettings" | "getBenchSettings">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
  /** Dispatch only: reaching an agent's own mailbox to ask it for a
   * turn. Nothing on the human write path touches it. */
  readonly platform: Pick<WorkbenchMail, "sendMail">;
  /**
   * One in-flight turn per workbench (CL-6331): every message's
   * recipient fan-out runs through this queue rather than dispatching
   * straight to `dispatchTurn`, so a message arriving mid-turn queues
   * instead of racing the turn already running, and batches with
   * whatever else queued alongside it into one combined next turn once
   * that claim releases. See `./turn-queue.ts`.
   */
  readonly turnQueue: WorkbenchTurnQueue;
  /**
   * The turn projection (CL-6329). `dispatchTurn` opens a row before it
   * touches the execution plane, so an in-flight turn is visible from
   * its first moment and the child run id its reply will carry is
   * already allocated. Optional so unit suites that only exercise
   * routing stay free of the table; a composition that wants traceable
   * replies (the hub) injects a real store.
   */
  readonly agentTurns?: AgentTurnStore;
  /**
   * Narrows a turn's context to its own thread. Absent, a turn is asked
   * with the whole room. See `./turn-context.ts`.
   */
  readonly threads?: Pick<ThreadStore, "listThreadAssignments">;
};

export type SendWorkbenchMessageInput = {
  readonly tenantId: string;
  readonly principalId: string;
  /** The address the sender's message is posted under — `id@domain`,
   * the same shape every participant address carries. */
  readonly senderAddress: string;
  readonly workbenchId: string;
  readonly messageParts: PartType[];
  /**
   * A plain reply's parent message id. Deterministic routing: a reply
   * to an agent's message reaches that agent even when the reply text
   * mentions nobody — the reply gesture is itself an address.
   */
  readonly inReplyToMessageId?: string;
  /**
   * A participant this message must reach regardless of what its text
   * mentions (CL-6451): an `@name` typed as a definition's wire name
   * ("assistant") resolves to a participant whose handle derives from
   * its display name ("myra"), so mention matching alone would miss it.
   * The command intercept resolves that residency and passes the
   * participant's address here, so the message rides the ordinary turn
   * pipeline — queueing behind an in-flight turn like any mention —
   * into the run the room already has.
   */
  readonly forcedRecipientAddress?: string;
};

export type SendWorkbenchMessageResult = {
  readonly id: string;
  readonly createdAt: string;
  /**
   * Settles once this message's routing intent is resolved: either its
   * turn actually dispatched (or its failure surfaced as a notice on
   * the timeline — it never rejects), or — CL-6331 — it queued behind a
   * turn already in flight for this workbench, in which case this
   * settles as soon as it's queued, not once it eventually dispatches
   * as part of a later batch. Dispatch can wake a slept agent, which is
   * a full redeploy, so the sender's own message is persisted,
   * published, and returned without waiting on any of it; a caller that
   * needs a message actually SENT (not merely queued) to be settled —
   * a test proving delivery, or a synchronous relay — has to know a
   * queued message's own delivery lands on whichever later message's
   * `fanoutDelivered` triggers the drain (see `./turn-queue.ts`), not on
   * this one.
   */
  readonly fanoutDelivered: Promise<void>;
};

/**
 * Resolves which agent participant a reply targets: the agent that
 * authored the parent message, when the parent is found and was
 * authored by a known agent participant. Undefined for a reply to a
 * human message, an unknown message id, or no reply at all.
 */
async function replyTargetAgent(
  roomMessages: Pick<RoomMessageStore, "getMessage">,
  input: {
    tenantId: string;
    workbenchId: string;
    inReplyToMessageId: string;
    participants: readonly ParticipantRecord[];
  },
): Promise<string | undefined> {
  const parent = await roomMessages.getMessage({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    messageId: input.inReplyToMessageId,
  });
  if (parent === undefined) return undefined;
  const match = input.participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(parent.sender.address),
  );
  return match?.address;
}

/**
 * Posts a message into a workbench and routes it to every agent its
 * mentions, reply target, and host-default resolve to. The message
 * itself is one row plus one publish — no mail, no wake, no sidecar hop
 * — so a workbench with every agent process stopped still takes
 * messages and still renders them.
 *
 * Routing never branches on the workbench's `kind` (a chat and a
 * workbench are routed identically): an `@mention` always reaches its
 * agent; a plain reply to an agent's message reaches that agent too,
 * even unmentioned; and a message naming no agent at all (no mention,
 * no agent reply target) defaults to the workbench's host — its first
 * agent participant — so a single-agent workbench still auto-responds
 * and a multi-agent one routes through its host instead of going
 * silent.
 */
export async function sendWorkbenchMessage(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
): Promise<SendWorkbenchMessageResult> {
  const posted = await postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.senderAddress },
    senderPrincipalId: input.principalId,
    parts: input.messageParts,
  });

  return {
    id: posted.id,
    createdAt: posted.createdAt,
    fanoutDelivered: routeMessage(deps, input, posted.id),
  };
}

/**
 * Everything the sender's own message does NOT have to wait for:
 * resolving which agents this message is for, loading the re-situating
 * context a mentioned agent needs, and asking each of them for a turn.
 * A dispatch wakes an unroutable agent first — a full redeploy of a
 * slept one — so keeping this off the request path is what stops a
 * quiet workbench's first message from paying deploy time before the
 * sender's own bubble confirms.
 *
 * Never rejects. An agent that stays unreachable gets an honest notice
 * on the timeline in its own voice, matching how the orchestrator
 * already reports a turn that produced nothing — a sender must never be
 * left believing an agent received something it never did.
 */
async function routeMessage(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
  messageId: string,
): Promise<void> {
  try {
    await routeToRecipients(deps, input, messageId);
  } catch (err) {
    fanoutLog.error(
      "Routing failed for workbench {workbenchId}'s message {messageId}; " +
        "the message itself is durable, but the agents it names may never " +
        "have been asked for a turn",
      { workbenchId: input.workbenchId, messageId, err },
    );
  }
}

/**
 * The thread a turn's context is confined to (CL-6329): a message inside
 * a sub-thread is answered with that sub-thread, never the whole room.
 * Returns nothing at all when the workbench has no thread store or the
 * triggering message carries no membership row — the room itself is the
 * scope then, which is exactly `assembleTurnContext`'s no-thread case.
 *
 * Membership is read once, in bulk, so the resolver `assembleTurnContext`
 * calls per message stays synchronous rather than fanning a query out
 * per timeline row.
 */
async function turnThreadScope(
  deps: Pick<SendWorkbenchMessageDeps, "threads">,
  input: Pick<SendWorkbenchMessageInput, "tenantId" | "workbenchId">,
  messageId: string,
): Promise<{ thread?: TurnContextThreadScope }> {
  if (deps.threads === undefined) return {};
  const assignments = await deps.threads.listThreadAssignments(
    input.tenantId,
    input.workbenchId,
  );
  const threadId = assignments.get(messageId);
  if (threadId === undefined) return {};
  return {
    thread: {
      threadId,
      threadIdOf: (id) => assignments.get(id) ?? "",
    },
  };
}

async function routeToRecipients(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
  messageId: string,
): Promise<void> {
  const settingsRow = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];

  const recipientSet = new Set(
    mentionedParticipants(input.messageParts, participants),
  );
  if (input.forcedRecipientAddress !== undefined) {
    recipientSet.add(input.forcedRecipientAddress);
  }
  if (input.inReplyToMessageId !== undefined) {
    const target = await replyTargetAgent(deps.roomMessages, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      inReplyToMessageId: input.inReplyToMessageId,
      participants,
    });
    if (target !== undefined) recipientSet.add(target);
  }
  // No mention and no agent reply target: the default-routing case,
  // where the host receives every such message unconditionally — the
  // same standing relationship a chat's one agent has always had, so
  // it needs no re-situating context either.
  const isDefaultRouting = recipientSet.size === 0;
  if (isDefaultRouting) {
    const host = participants.find((participant) =>
      isAgentAddress(participant.address),
    );
    if (host !== undefined) recipientSet.add(host.address);
  }
  const recipients = [...recipientSet];

  const contextText =
    !isDefaultRouting && recipients.length > 0
      ? await assembleTurnContext({
          roomMessages: deps.roomMessages,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          excludeMessageId: messageId,
          participants,
          contextWindow: resolveContextWindow(
            settingsRow?.settings ?? {},
            benchContextWindowOf(
              (await deps.store.getBenchSettings(input.tenantId))?.settings ??
                {},
            ),
          ).value,
          ...(await turnThreadScope(deps, input, messageId)),
        })
      : undefined;
  const turnParts =
    contextText !== undefined
      ? (mergeContextIntoParts(contextText, input.messageParts) as PartType[])
      : input.messageParts;

  await deps.turnQueue.run(
    input.workbenchId,
    {
      messageId,
      principalId: input.principalId,
      recipients,
      parts: turnParts,
    },
    (batch) =>
      dispatchTurnBatch(deps, input.tenantId, input.workbenchId, batch),
  );
}

/**
 * Runs one workbench turn — either a single message's own fan-out, or
 * several queued messages batched together (CL-6331) — against every
 * recipient the batch names, unioned in arrival order and de-duplicated
 * so an agent mentioned across more than one queued message is still
 * only asked once. Each queued message's parts are concatenated in the
 * same order, so the combined context an agent sees reads the same
 * left-to-right order the room itself does. Never rejects: a recipient
 * that can't be reached gets an undelivered notice in its own voice,
 * exactly as a single, unqueued message's fan-out always has.
 */
async function dispatchTurnBatch(
  deps: Pick<SendWorkbenchMessageDeps, "platform" | "roomMessages" | "publish">,
  tenantId: string,
  workbenchId: string,
  batch: readonly QueuedTurn[],
): Promise<void> {
  const recipientSet = new Set<string>();
  for (const turn of batch) {
    for (const agentAddress of turn.recipients) recipientSet.add(agentAddress);
  }
  const recipients = [...recipientSet];
  const parts = batch.flatMap((turn) => turn.parts) as PartType[];
  const last = batch[batch.length - 1];
  if (last === undefined) return;
  const messageIds = batch.map((turn) => turn.messageId);

  // Concurrent: agents are independent, and a dispatch that has to wake
  // its target pays a full redeploy — serially, one slept agent would
  // delay every agent mentioned after it.
  await Promise.all(
    recipients.map(async (agentAddress) => {
      try {
        await dispatchTurn(deps, {
          tenantId,
          workbenchId,
          principalId: last.principalId,
          agentAddress,
          parts,
          requestMessageIds: messageIds,
        });
      } catch (err) {
        fanoutLog.error(
          "Asking {agentAddress} for a turn failed for workbench " +
            "{workbenchId}'s message(s) {messageIds}; posting an " +
            "undelivered notice in its voice: {err}",
          {
            agentAddress,
            workbenchId,
            messageIds,
            err,
          },
        );
        await postUndeliveredNotice(deps, {
          tenantId,
          workbenchId,
          agentAddress,
          cause: err,
        });
      }
    }),
  );
}

export type DispatchTurnInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly agentAddress: string;
  readonly parts: PartType[];
  /** The room messages this turn answers, in arrival order. */
  readonly requestMessageIds: readonly string[];
};

/**
 * Asks one agent for a turn — the seam between the room (rows on a
 * timeline) and the execution plane.
 *
 * A room agent deploys as an `onTrigger` section (CL-6329, see
 * `./standalone-launch.ts`'s `AGENT_SECTION_MODE`), so this fires that
 * section's trigger: one occurrence, running as its own child run
 * (`turn__<n>`) with its own event log, against the one warm run the
 * (agent, workbench) pair already holds. The trigger is a mail trigger —
 * that is the primitive the section subscribes on — so `sendMail`
 * remains the transport, but what it starts is now an occurrence rather
 * than another turn folded into one endless step.
 *
 * The projection row opens BEFORE the trigger fires, so an in-flight
 * turn is visible from its first moment and the child run id its reply
 * will carry is already allocated. A trigger that never lands closes the
 * row `failed` and rethrows, leaving the caller to post the undelivered
 * notice it always has.
 */
export async function dispatchTurn(
  deps: Pick<SendWorkbenchMessageDeps, "platform" | "agentTurns">,
  input: DispatchTurnInput,
): Promise<void> {
  const turn = await deps.agentTurns?.startTurn({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    agentAddress: input.agentAddress,
    requestMessageIds: input.requestMessageIds,
  });
  try {
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(input.agentAddress),
      principalId: input.principalId,
      content: encodeParts(input.parts, { replyTo: input.workbenchId }),
      fromWorkbenchId: input.workbenchId,
    });
  } catch (err) {
    if (turn !== undefined) {
      await deps.agentTurns?.finishTurn({
        tenantId: input.tenantId,
        turnId: turn.id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

const CREDENTIAL_UNDELIVERED_NOTICE =
  "I can't reach a model right now — add or check your model key in " +
  "Settings, then I'll pick this up.";
const RETRYABLE_UNDELIVERED_NOTICE =
  "I didn't get that one — send it again and I'll pick it up.";

/**
 * Whether a dispatch failure is a credential/inference-resolution
 * problem resending can never fix — as opposed to a genuinely transient
 * failure (sidecar hiccup, momentary network blip) where "send it again"
 * is honest advice. `InferenceResolutionError` (`@corbits/folded-runs`)
 * is the launch-time case: the agent's definition has no resolvable
 * inference source at all. A dispatch failure whose own status/code
 * marks it a 401 `credential_failure` is the runtime case: a source
 * resolved, but the credential itself was rejected. Every other cause —
 * unclassified, or missing that shape entirely — is treated as
 * genuinely retryable, per the "conservative classification" rule
 * `chat-orchestrator.ts`'s own provider-health reporting already follows:
 * silence (here, the generic notice) over a wrong attribution.
 */
function isCredentialDispatchFailure(cause: unknown): boolean {
  if (cause instanceof InferenceResolutionError) return true;
  if (cause !== null && typeof cause === "object") {
    const status = (cause as { status?: unknown; statusCode?: unknown }).status;
    const statusCode = (cause as { statusCode?: unknown }).statusCode;
    const code = (cause as { code?: unknown; category?: unknown }).code;
    const category = (cause as { category?: unknown }).category;
    if (status === 401 || statusCode === 401) return true;
    if (code === "credential_failure" || category === "credential_failure")
      return true;
  }
  return false;
}

/**
 * Reports one agent that could not be reached on the timeline, in that
 * agent's own voice and from its own address — the same attribution its
 * real replies carry — so an unreachable teammate reads as a teammate
 * who missed the message rather than as silence. The notice itself is
 * cause-aware (CL-6360, owner hit it live): a credential or
 * inference-resolution failure gets copy that actually helps ("add or
 * check your model key"), never the generic "send it again" that lies
 * about resending ever being able to help. Swallows its own failure: if
 * the timeline itself is unreachable there is nowhere left to say so,
 * and the error is already logged by the caller.
 */
async function postUndeliveredNotice(
  deps: Pick<SendWorkbenchMessageDeps, "roomMessages" | "publish">,
  input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
    readonly cause: unknown;
  },
): Promise<void> {
  try {
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      sender: { name: null, address: input.agentAddress },
      runId: localPartOf(input.agentAddress),
      parts: [
        {
          kind: "text",
          text: isCredentialDispatchFailure(input.cause)
            ? CREDENTIAL_UNDELIVERED_NOTICE
            : RETRYABLE_UNDELIVERED_NOTICE,
          turnFailed: true,
        },
      ],
    });
  } catch (err) {
    fanoutLog.error(
      "Could not post the undelivered notice for {agentAddress} onto " +
        "workbench {workbenchId}'s timeline: {err}",
      { agentAddress: input.agentAddress, workbenchId: input.workbenchId, err },
    );
  }
}
