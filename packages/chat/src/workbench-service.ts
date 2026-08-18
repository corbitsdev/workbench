// Workbench-level orchestration that sits above the platform port:
// joining an agent into a workbench (shared by chat creation and
// `POST .../invite`), sending a message with its full mention fan-out
// — recipient resolution, prior-context loading, and the per-recipient
// delivery loop — and provisioning a bare new space workbench for a
// caller (like a routine) that names no existing destination. Each
// depends only on the platform/store seams it actually calls, not the
// full `ChatPlatform`/`ChatStore`.
import { formatRunAddress } from "@intx/types";
import type { InferencePreference } from "@intx/agent";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { decodeMail, encodeParts, senderOf } from "./codec";
import type { Part as PartType } from "./parts";
import { localPartOf } from "./agent-address";
import { isAgentAddress, mentionedParticipants } from "./mentions";
import {
  buildDroppedRecap,
  DROPPED_RECAP_LOOKBACK,
  mergeContextIntoParts,
  renderWorkbenchContext,
  type WorkbenchContextItem,
} from "./workbench-context";
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
import {
  buildWorkbenchHostWorkflow,
  serializeWorkbenchHostWorkflow,
} from "./workbench-workflow";
import { presetForKind } from "./kinds";
import type {
  WorkbenchLauncher,
  WorkbenchMail,
  ChatWorkbenchEvent,
  InvitableDefinition,
  ListedMailItem,
} from "./platform-port";
import type { WorkbenchTenancyStore } from "./workbench-tenancy";
import type { ChatStore } from "./store";

const contextLog = getLogger(["chat", "context"]);
const provisionLog = getLogger(["chat", "provision-space"]);
const removeLog = getLogger(["chat", "remove-participant"]);
const greetingLog = getLogger(["chat", "greeting-kickoff"]);

export type ProvisionSpaceWorkbenchDeps = {
  readonly tenancy: Pick<
    WorkbenchTenancyStore,
    "createWorkbenchTenant" | "compensateWorkbenchTenant"
  >;
  readonly platform: WorkbenchLauncher;
  readonly store: Pick<ChatStore, "createWorkbenchSettings">;
  readonly workbenchHostInferencePreferences?:
    ((tenantId: string) => Promise<readonly InferencePreference[]>) | undefined;
  readonly turnTimeoutMs: number;
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
 * tenant, launch its workbench host, write its base settings), the same
 * three steps `POST /workbenches` runs for a named space — used by a
 * caller (a routine's create route, chiefly) that needs to hand a
 * fresh destination to something else in the same request rather than
 * collecting one from a picker first. Mirrors `POST /workbenches`'s own
 * mint-then-compensate shape: the tenant mint is one transaction, the
 * host launch is a separate step, and a launch failure is compensated
 * (the orphaned tenant deleted) before the error propagates.
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
  const triggerAddress = formatRunAddress(workbenchId, input.tenantDomain);
  const inferencePreferences =
    (await deps.workbenchHostInferencePreferences?.(input.tenantId)) ?? [];
  const definition = serializeWorkbenchHostWorkflow(
    buildWorkbenchHostWorkflow({
      triggerAddress,
      inferencePreferences,
      turnTimeoutMs: deps.turnTimeoutMs,
    }),
  );

  const workbenchTenant = await deps.tenancy.createWorkbenchTenant({
    parentTenantId: input.tenantId,
    workbenchId,
    name: input.name,
    creatorUserId: input.creatorUserId,
  });

  try {
    await deps.platform.launchWorkbench({
      tenantId: input.tenantId,
      creatorPrincipalId: input.creatorPrincipalId,
      workbenchId,
      triggerAddress,
      definition,
    });
  } catch (err) {
    provisionLog.error(
      "Workbench host launch failed for {workbenchId} after minting " +
        "{tenantId}; compensating the orphaned tenant",
      { workbenchId, tenantId: workbenchTenant.tenantId, err },
    );
    try {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    } catch (compensationErr) {
      provisionLog.error(
        "Compensation failed for orphaned tenant {tenantId} after " +
          "workbench {workbenchId}'s launch failure; this tenant is now a " +
          "privileged orphan with no workbench pointing at it and " +
          "requires manual cleanup",
        { workbenchId, tenantId: workbenchTenant.tenantId, compensationErr },
      );
    }
    throw err;
  }

  const preset = presetForKind("workbench");
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

  return {
    workbenchId,
    compensate: async () => {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    },
  };
}

export type LaunchAndJoinAgentDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly platform: WorkbenchLauncher & Pick<WorkbenchMail, "sendMail">;
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
};

/**
 * The invite core: launches the definition's own instance, derives
 * its friendly mention handle, appends the participant record, posts
 * the join event onto the workbench's timeline, and arms the reply
 * bridge. Shared by `POST .../invite` and chat creation (a chat's
 * single agent is invited exactly this way, at creation) so the two
 * paths can never drift.
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
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    principalId: input.principalId,
    content: encodeParts([joinEvent]),
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
  };
}

export type DispatchGreetingKickoffDeps = {
  readonly platform: Pick<WorkbenchMail, "sendMail">;
};

export type GreetingKickoffBriefInput = {
  /** The opener's display name, when the host can resolve one. */
  readonly senderName?: string;
  /** The workbench's title, when it has one beyond its id. */
  readonly workbenchName?: string;
  /** The opening date as dd/mm/yyyy, so the agent knows what day it is. */
  readonly openedOn?: string;
  /** True for a direct 1:1 chat minted against a single agent
   * definition. A DM's row is titled with the AGENT's own name, never
   * one the person chose for the room, so the brief drops the
   * workbench-name clause entirely and greets as a direct conversation
   * rather than a shared workbench. */
  readonly isDirectChat?: boolean;
};

export function kickoffDate(now: Date): string {
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${now.getFullYear()}`;
}

export type DispatchGreetingKickoffInput = GreetingKickoffBriefInput & {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly agentAddress: string;
};

/** Placeholder titles a workbench gets by default, not a brief the
 * opener chose to type — "Session A", "test", "Untitled" and the like
 * describe the box, not the ask, so the kickoff brief omits them
 * entirely rather than letting the model read them as the task. */
const GENERIC_WORKBENCH_NAME = /^(new workbench|untitled|session|room|test)\b/i;

/** `generateId`'s own shape (see `@intx/hub-common`'s `ids.ts`): a short
 * lowercase prefix, an underscore, then a hex or opaque token — never a
 * name a person typed. A mint that falls through to an id (or otherwise
 * un-titled row) must never let that id read as a chosen title in the
 * greeting. */
const ID_SHAPED_WORKBENCH_NAME = /^[a-z]+_[a-z0-9]{6,}$/i;

/**
 * The kickoff mail's text: the facts the agent needs to say a grounded
 * hello (who opened the workbench, what it is called) plus how to say
 * it. It is delivered to the agent's own mailbox and never rendered on
 * the timeline, so it reads as a brief, not as a human message. Keeping
 * the greeting dynamic (the model writes it from these facts) rather
 * than a canned script is what lets it name the person and the
 * workbench, and lead with a first step when the name hints at one.
 *
 * A workbench's title is a label the opener picked for the room, never
 * a task description — a chat named "Copywriter test" is not a request
 * for copywriting. Generic/placeholder titles are dropped from the
 * brief entirely; distinctive ones are still passed along, but framed
 * explicitly as a label to nod to at most once, never as the thing
 * being asked of the agent.
 *
 * A direct 1:1 chat (`isDirectChat`) skips the workbench-name clause
 * entirely, no matter what `workbenchName` carries: a DM's row is
 * titled with the invited AGENT's own name (there is no room name a
 * person chose), so naming it back to the agent reads as the agent
 * greeting itself under its own name — the bug this branch exists to
 * prevent. The brief instead frames it as a direct conversation.
 */
export function greetingKickoffBrief(input: GreetingKickoffBriefInput): string {
  const who =
    input.senderName !== undefined && input.senderName !== ""
      ? input.senderName
      : "someone";
  const dated =
    input.openedOn !== undefined && input.openedOn !== ""
      ? `Today's date is ${input.openedOn} (dd/mm/yyyy). `
      : "";
  if (input.isDirectChat === true) {
    return (
      `You're in a direct chat with ${who}. ` +
      `${dated}` +
      "Greet them briefly as yourself, first person, by name if you " +
      "have one. No menu of options and no talk of memory, lookups, " +
      "or what you could not find. Ask what they need."
    );
  }
  const hasDistinctiveName =
    input.workbenchName !== undefined &&
    input.workbenchName !== "" &&
    !GENERIC_WORKBENCH_NAME.test(input.workbenchName) &&
    !ID_SHAPED_WORKBENCH_NAME.test(input.workbenchName);
  const named = hasDistinctiveName ? ` titled "${input.workbenchName}"` : "";
  const labelNote = hasDistinctiveName
    ? `The workbench is titled "${input.workbenchName}" — that is a label ` +
      "the person chose, not a request; you may nod to it at most once, " +
      "never treat it as their brief or answer it as a question. "
    : "";
  return (
    `${who} just opened a new workbench${named} with you in it. ` +
    `${dated}` +
    `${labelNote}` +
    "Say hello as a teammate would: two or three sentences, first " +
    "person, address them by name if you have one. No menu of " +
    "options and no talk of memory, lookups, or what you could not " +
    "find. Ask what they are working on."
  );
}

/**
 * Fires a newly-minted chat's one agent's very first turn the moment
 * it joins, so a fresh room is never silent until a human speaks
 * first. Sends a kickoff mail straight to the agent's own mailbox —
 * never the chat's own workbench id — the exact opening-mail pattern
 * `startWorkflowCommand` already uses; only mail sent to the chat's
 * own workbench id is ever rendered onto its timeline, so this
 * structurally cannot appear as a human bubble. The visible greeting
 * text itself comes entirely from the agent's own system prompt (the
 * assistant workflow and task-planner drafting both already carry a
 * greet-first instruction) — this call only supplies the trigger.
 *
 * Errors are logged, never thrown: the caller fires this after the
 * chat has already been minted successfully, and a greeting that
 * fails to dispatch must never fail — or roll back — the mint itself.
 */
export async function dispatchGreetingKickoff(
  deps: DispatchGreetingKickoffDeps,
  input: DispatchGreetingKickoffInput,
): Promise<void> {
  try {
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(input.agentAddress),
      principalId: input.principalId,
      content: encodeParts([
        {
          kind: "text",
          text: greetingKickoffBrief({
            ...(input.senderName !== undefined
              ? { senderName: input.senderName }
              : {}),
            ...(input.workbenchName !== undefined
              ? { workbenchName: input.workbenchName }
              : {}),
            openedOn: kickoffDate(new Date()),
          }),
        },
      ]),
      fromWorkbenchId: input.workbenchId,
    });
  } catch (err) {
    greetingLog.error(
      "Greeting kickoff dispatch failed for workbench {workbenchId}'s agent " +
        "{agentAddress}; the chat was minted successfully but its agent " +
        "will only speak once a human sends the first message",
      { workbenchId: input.workbenchId, agentAddress: input.agentAddress, err },
    );
  }
}

export type JoinHumanParticipantDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly platform: Pick<WorkbenchMail, "sendMail">;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
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
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    principalId: input.principalId,
    content: encodeParts([joinEvent]),
  });

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: input.memberPrincipalId,
    handle: input.memberHandle,
    settings: row.settings,
  };
}

export type RemoveWorkbenchParticipantDeps = {
  readonly store: Pick<ChatStore, "updateWorkbenchSettings">;
  readonly platform: Pick<WorkbenchMail, "sendMail">;
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
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    principalId: input.principalId,
    content: encodeParts([leaveEvent]),
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

  const joined = await launchAndJoinAgent(
    { store: deps.store, platform: deps.platform, publish: deps.publish },
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

/**
 * The label a sender renders as inside a workbench context block: an
 * agent participant renders as its workbench handle (`@echo`), matching
 * the mention syntax participants already type; anything else — the
 * server has no human display names to draw on — renders as the
 * literal string `"user"`. Never a raw address or principal id: this
 * text reaches a model prompt and possibly logs.
 */
function labelForSender(
  address: string,
  participants: readonly ParticipantRecord[],
): string {
  // Mail's `from` always carries a full `id@domain` address regardless
  // of sender kind (see `platform-adapter.ts`'s `sendMail`), so an
  // agent sender is recognized by matching its local part against a
  // known *agent* participant's local part — never by the mere
  // presence of "@", which every mail sender address carries either
  // way.
  const known = participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(address),
  );
  return known !== undefined ? `@${known.handle}` : "user";
}

/**
 * Decodes a single listed mail item into a context item, or `undefined`
 * for event-only mail with no text parts — contributes nothing a
 * context block can render.
 */
async function decodeContextItem(
  platform: Pick<WorkbenchMail, "fetchBlob">,
  workbenchId: string,
  item: ListedMailItem,
  participants: readonly ParticipantRecord[],
): Promise<WorkbenchContextItem | undefined> {
  const parts = await decodeMail(item.mail, {
    fetchBlob: (blobId) => platform.fetchBlob(workbenchId, blobId),
  });
  const texts = parts
    .filter(
      (part): part is Extract<PartType, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text);
  if (texts.length === 0) return undefined;
  const sender = senderOf(item.mail);
  return {
    label: labelForSender(sender.address, participants),
    text: texts.join(" "),
  };
}

/**
 * Loads and decodes the workbench's recent timeline into context items
 * for a mention fan-out copy, excluding the just-sent message (matched
 * by mail id, since it is typically the newest item in the listing)
 * and any decoded message with no text parts (event-only mail
 * contributes nothing a context block can render). Capped to the
 * workbench's resolved `contextWindow` (most-recent-first before the
 * final oldest-first slice, so a window of 0 loads nothing and a small
 * window keeps only the newest few).
 *
 * When the workbench carries more messages than the window keeps, the
 * dropped span (CL-6204) is folded into one synthetic recap entry
 * (`buildDroppedRecap`) prepended ahead of the kept items, rather than
 * silently vanishing. The listing is paged (`listMail`'s own cursor)
 * out to `contextWindow + DROPPED_RECAP_LOOKBACK` items — just enough
 * to cover the window plus the recap's own bounded lookback — never
 * further: a dropped span longer than that is still counted (and its
 * date range still reported) from what was fetched, just marked as a
 * lower bound (`moreBeyondFold`) rather than pretending to know the
 * exact total.
 *
 * Returns `undefined` when there is nothing to show at all — no kept
 * items and no recap — or when the timeline fails to load or decode:
 * that failure must never break the send, so it is logged and
 * swallowed here, leaving the caller to fan out un-situated.
 */
async function loadWorkbenchContext(input: {
  platform: Pick<WorkbenchMail, "listMail" | "fetchBlob">;
  tenantId: string;
  workbenchId: string;
  excludeMailId: string;
  participants: readonly ParticipantRecord[];
  contextWindow: number;
}): Promise<string | undefined> {
  if (input.contextWindow === 0) return undefined;
  try {
    const fetchCap = input.contextWindow + DROPPED_RECAP_LOOKBACK;
    const fetched: ListedMailItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await input.platform.listMail(
        cursor === undefined
          ? { tenantId: input.tenantId, workbenchId: input.workbenchId }
          : {
              tenantId: input.tenantId,
              workbenchId: input.workbenchId,
              cursor,
            },
      );
      fetched.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined && fetched.length < fetchCap);

    const newestFirstExcludingSent = fetched
      .filter((item) => item.id !== input.excludeMailId)
      .slice(0, fetchCap);
    const moreBeyondFold = cursor !== undefined;

    const windowMail = newestFirstExcludingSent.slice(0, input.contextWindow);
    const droppedMail = newestFirstExcludingSent.slice(input.contextWindow);
    const wasDropped = droppedMail.length > 0 || moreBeyondFold;

    const items: WorkbenchContextItem[] = [];
    for (const item of [...windowMail].reverse()) {
      const decoded = await decodeContextItem(
        input.platform,
        input.workbenchId,
        item,
        input.participants,
      );
      if (decoded !== undefined) items.push(decoded);
    }

    let recap: WorkbenchContextItem | undefined;
    if (wasDropped) {
      const droppedItems: WorkbenchContextItem[] = [];
      for (const item of droppedMail) {
        const decoded = await decodeContextItem(
          input.platform,
          input.workbenchId,
          item,
          input.participants,
        );
        if (decoded !== undefined) droppedItems.push(decoded);
      }
      const humanTexts = [...droppedItems]
        .reverse()
        .filter((item) => item.label === "user")
        .map((item) => item.text);
      const oldestDropped = droppedMail[droppedMail.length - 1];
      const newestDropped = droppedMail[0];
      recap =
        oldestDropped !== undefined && newestDropped !== undefined
          ? buildDroppedRecap({
              droppedCount: droppedMail.length,
              moreBeyondFold,
              humanTexts,
              firstDate: oldestDropped.createdAt,
              lastDate: newestDropped.createdAt,
            })
          : buildDroppedRecap({
              droppedCount: droppedMail.length,
              moreBeyondFold,
              humanTexts,
            });
    }

    if (items.length === 0 && recap === undefined) return undefined;
    return recap !== undefined
      ? renderWorkbenchContext({ items, recap })
      : renderWorkbenchContext({ items });
  } catch (err) {
    contextLog.warn`failed to load workbench context for mention fan-out on workbench ${input.workbenchId}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return undefined;
  }
}

export type SendWorkbenchMessageDeps = {
  readonly store: Pick<ChatStore, "getWorkbenchSettings" | "getBenchSettings">;
  readonly platform: Pick<
    WorkbenchMail,
    "sendMail" | "listMail" | "fetchBlob" | "getMail"
  >;
};

export type SendWorkbenchMessageInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly messageParts: PartType[];
  /**
   * A plain reply's parent message id. Deterministic routing: a reply
   * to an agent's message reaches that agent even when the reply text
   * mentions nobody — the reply gesture is itself an address.
   */
  readonly inReplyToMessageId?: string;
};

export type SendWorkbenchMessageResult = {
  readonly id: string;
  readonly createdAt: string;
};

/**
 * Resolves which agent participant a reply targets: the agent that
 * authored the parent message, when the parent is found and was
 * authored by a known agent participant. Undefined for a reply to a
 * human message, an unknown message id, or no reply at all.
 */
async function replyTargetAgent(
  deps: Pick<SendWorkbenchMessageDeps["platform"], "getMail">,
  input: {
    tenantId: string;
    workbenchId: string;
    inReplyToMessageId: string;
    participants: readonly ParticipantRecord[];
  },
): Promise<string | undefined> {
  const parent = await deps.getMail({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    messageId: input.inReplyToMessageId,
  });
  if (parent === undefined) return undefined;
  const sender = senderOf(parent.mail);
  const match = input.participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(sender.address),
  );
  return match?.address;
}

/**
 * Sends a message into a workbench and fans it out to every recipient
 * its mentions, reply target, and host-default resolve to — routing
 * never branches on the workbench's `kind` (a chat and a workbench are
 * routed identically): an `@mention` always reaches its agent; a plain
 * reply to an agent's message reaches that agent too, even unmentioned;
 * and a message naming no agent at all (no mention, no agent reply
 * target) defaults to the workbench's host — its first agent
 * participant — so a single-agent workbench still auto-responds and a
 * multi-agent one routes through its host instead of going silent.
 */
export async function sendWorkbenchMessage(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
): Promise<SendWorkbenchMessageResult> {
  const sent = await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    principalId: input.principalId,
    content: encodeParts(input.messageParts),
  });

  const settingsRow = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];

  const recipientSet = new Set(
    mentionedParticipants(input.messageParts, participants),
  );
  if (input.inReplyToMessageId !== undefined) {
    const target = await replyTargetAgent(deps.platform, {
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
      ? await loadWorkbenchContext({
          platform: deps.platform,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          excludeMailId: sent.id,
          participants,
          contextWindow: resolveContextWindow(
            settingsRow?.settings ?? {},
            benchContextWindowOf(
              (await deps.store.getBenchSettings(input.tenantId))?.settings ??
                {},
            ),
          ).value,
        })
      : undefined;
  const fanoutParts =
    contextText !== undefined
      ? (mergeContextIntoParts(contextText, input.messageParts) as PartType[])
      : input.messageParts;

  for (const participant of recipients) {
    // The chat orchestrator (built once by the host, subscribed to the
    // sidecar's own event stream) is what turns this participant's
    // eventual `connector.reply` back into a workbench message — no
    // per-delivery arming needed here anymore.
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(participant),
      principalId: input.principalId,
      content: encodeParts(fanoutParts, { replyTo: input.workbenchId }),
      fromWorkbenchId: input.workbenchId,
    });
  }

  return sent;
}
