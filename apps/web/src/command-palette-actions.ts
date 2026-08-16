// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Each create command uses the same off-route-safe pending-flag
// pattern `library-upload.ts` already established: the palette can fire
// from any page, before the target page (and its window-event listener) has
// mounted, so a same-tick `dispatchEvent` would be a race the listener
// always loses. `pending-dialog-request.ts` generalizes that pattern; the
// target pages/sections (routines-page.tsx, skills-settings-section.tsx,
// chat-page.tsx) consume the pending flag on mount. Skills moved from its
// own route into a Settings section (CL-5990) — "New skill" lands on
// `/settings/skills`. The global agents settings tab was later removed
// (CL-6121); "New agent" now mints a fresh workbench, same as "New
// workbench". "New thread" is out of scope (killed by owner decision).

import { createPendingDialogRequest } from "@corbits/shell-layout";
import {
  CHANNEL_PATH_PREFIX,
  channelPath,
  isChannelPath,
} from "./channel-path";
import { ensureMyraChannel } from "./myra-channel";
import { requestLibraryUpload } from "./library-upload";
import {
  resetPendingRoutinePrefill,
  setPendingRoutinePrefill,
} from "./routine-prefill";
import type { RoutinePrefill } from "./routine-prefill";

export const NEW_CHANNEL_EVENT = "workbench:chat:new-channel";
export const NEW_ROUTINE_EVENT = "workbench:routines:create";
export const NEW_SKILL_EVENT = "workbench:skills:create";
export const NEW_TASK_EVENT = "workbench:tasks:create";

const newChannelRequest = createPendingDialogRequest();
const newRoutineRequest = createPendingDialogRequest();
const newSkillRequest = createPendingDialogRequest();
const newTaskRequest = createPendingDialogRequest();

/** Consumed by chat-page.tsx on mount. */
export const consumePendingNewChannel = newChannelRequest.consumePending;

/**
 * Requests the new-workbench picker — the same off-route-safe hop
 * `runActionCommand("new-channel", …)` uses, pulled out so every other
 * caller with no command-palette context (the sidebar's own "+ New
 * workbench" control, the "New agent" command, the routines page's "no
 * taskable agents" empty state) can request it too. Agent creation has no
 * route of its own — per the product model, "create an agent" mints a
 * fresh workbench.
 */
export function requestNewWorkbench(args: {
  readonly alreadyOnConversation: boolean;
  readonly navigateToConversations: () => void;
}): void {
  newChannelRequest.request({
    alreadyOnTargetRoute: args.alreadyOnConversation,
    navigateToTargetRoute: args.navigateToConversations,
    dispatch: () => window.dispatchEvent(new CustomEvent(NEW_CHANNEL_EVENT)),
  });
}
/** Consumed by routines-page.tsx on mount. */
export const consumePendingNewRoutine = newRoutineRequest.consumePending;
/** Consumed by skills-settings-section.tsx on mount. */
export const consumePendingNewSkill = newSkillRequest.consumePending;
/** Consumed by inbox-page.tsx on mount — the task composer opens there
 * (CL-6049): a task is spawn-and-return, its result reaches the Inbox,
 * so that's the one page that owns the affordance for starting one. */
export const consumePendingNewTask = newTaskRequest.consumePending;

/**
 * Requests the routine create/run affordance — the same off-route-safe hop
 * `runActionCommand("new-routine", …)` uses, pulled out so a caller with no
 * command-palette context (the chat composer's `/run`) can request it too.
 */
export function requestNewRoutine(args: {
  readonly alreadyOnRoutines: boolean;
  readonly navigateToRoutines: () => void;
}): void {
  newRoutineRequest.request({
    alreadyOnTargetRoute: args.alreadyOnRoutines,
    navigateToTargetRoute: args.navigateToRoutines,
    dispatch: () => window.dispatchEvent(new CustomEvent(NEW_ROUTINE_EVENT)),
  });
}

/**
 * Requests the routine create flow pre-filled from a completed task result
 * ("Make this a routine" — see inbox-page.tsx) — the same off-route-safe
 * hop `requestNewRoutine` uses, carrying the task's agent, prompt, and a
 * suggested name alongside it via routine-prefill.ts.
 */
export function requestMakeRoutine(args: {
  readonly alreadyOnRoutines: boolean;
  readonly navigateToRoutines: () => void;
  readonly prefill: RoutinePrefill;
}): void {
  setPendingRoutinePrefill(args.prefill);
  requestNewRoutine({
    alreadyOnRoutines: args.alreadyOnRoutines,
    navigateToRoutines: args.navigateToRoutines,
  });
}

/**
 * Requests the routine create flow with this space pre-bound as the
 * destination ("New routine in this space" — a channel header action or
 * the composer's `/routine` command). The same off-route-safe hop
 * `requestNewRoutine` uses, carrying only a `deliveryChannelId` via
 * routine-prefill.ts — the picker opens on this space selected, not
 * committed; the person can still pick something else.
 */
export function requestNewRoutineInSpace(args: {
  readonly alreadyOnRoutines: boolean;
  readonly navigateToRoutines: () => void;
  readonly deliveryChannelId: string;
}): void {
  setPendingRoutinePrefill({ deliveryChannelId: args.deliveryChannelId });
  requestNewRoutine({
    alreadyOnRoutines: args.alreadyOnRoutines,
    navigateToRoutines: args.navigateToRoutines,
  });
}

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
  newChannelRequest.resetPending();
  newRoutineRequest.resetPending();
  newSkillRequest.resetPending();
  newTaskRequest.resetPending();
  resetPendingRoutinePrefill();
}

export type ActionCommandId =
  | "new-channel"
  | "new-agent"
  | "new-routine"
  | "new-skill"
  | "new-task"
  | "upload-artifact"
  | "toggle-theme"
  | "close-canvas"
  | "talk-to-myra"
  | "go-channels"
  | "go-insights";

export type ActionCommand = {
  readonly id: ActionCommandId;
  readonly title: string;
  readonly subtitle: string;
};

/** Static catalog: id, title, subtitle. Matches the mock's action-command
 * titles, with "Install skill" relabeled "New skill" to match the shell's
 * current skills model: a person authors a skill into the workbench's own
 * registry (`skills-api.ts`) rather than installing one from a catalog. */
export const ACTION_COMMANDS: readonly ActionCommand[] = [
  {
    id: "new-channel",
    title: "New workbench",
    subtitle: "Search or create an agent",
  },
  { id: "new-agent", title: "New agent", subtitle: "Create with v1" },
  {
    id: "new-routine",
    title: "New routine",
    subtitle: "Schedule · trigger · demand",
  },
  { id: "new-skill", title: "New skill", subtitle: "Workbench capability" },
  {
    id: "new-task",
    title: "New task",
    subtitle: "Give an agent a prompt",
  },
  {
    id: "upload-artifact",
    title: "Upload artifact",
    subtitle: "Library · open dialog",
  },
  { id: "toggle-theme", title: "Toggle theme", subtitle: "Light / dark" },
  {
    id: "close-canvas",
    title: "Close canvas",
    subtitle: "Full-width stage",
  },
  {
    id: "talk-to-myra",
    title: "Talk to Myra",
    subtitle: "Open your personal agent",
  },
  {
    id: "go-channels",
    title: "Go to workbenches",
    subtitle: "Home · conversation list",
  },
  {
    id: "go-insights",
    title: "Go to insights",
    subtitle: "Not in the nav · still routable",
  },
];

export type ActionCommandContext = {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly tenantId: string | null;
  readonly cycleTheme: () => void;
  readonly closeCanvas: () => void;
};

/**
 * Runs one action command. The four create commands go through a pending
 * flag when the palette fires them off-route (see the module doc), so the
 * target page's own mount effect opens the dialog instead of a dispatch
 * racing against that page's not-yet-mounted listener.
 */
export async function runActionCommand(
  id: ActionCommandId,
  ctx: ActionCommandContext,
): Promise<void> {
  switch (id) {
    case "new-channel": {
      requestNewWorkbench({
        alreadyOnConversation: isChannelPath(ctx.path),
        navigateToConversations: () => ctx.navigate(channelPath(null)),
      });
      return;
    }
    case "new-agent": {
      // The global agents settings tab is gone — per the product model,
      // "Create new agent" mints a fresh workbench (same hop as
      // "New workbench"/the sidebar's own control).
      requestNewWorkbench({
        alreadyOnConversation: isChannelPath(ctx.path),
        navigateToConversations: () => ctx.navigate(channelPath(null)),
      });
      return;
    }
    case "new-routine": {
      requestNewRoutine({
        alreadyOnRoutines:
          ctx.path === "/routines" || ctx.path.startsWith("/routines/"),
        navigateToRoutines: () => ctx.navigate("/routines"),
      });
      return;
    }
    case "new-skill": {
      newSkillRequest.request({
        alreadyOnTargetRoute:
          ctx.path === "/settings/skills" ||
          ctx.path.startsWith("/settings/skills/"),
        navigateToTargetRoute: () => ctx.navigate("/settings/skills"),
        dispatch: () => window.dispatchEvent(new CustomEvent(NEW_SKILL_EVENT)),
      });
      return;
    }
    case "new-task": {
      newTaskRequest.request({
        alreadyOnTargetRoute: ctx.path === "/inbox",
        navigateToTargetRoute: () => ctx.navigate("/inbox"),
        dispatch: () => window.dispatchEvent(new CustomEvent(NEW_TASK_EVENT)),
      });
      return;
    }
    case "upload-artifact": {
      requestLibraryUpload({
        alreadyOnLibrary:
          ctx.path === "/library" || ctx.path.startsWith("/library/"),
        navigateToLibrary: () => ctx.navigate("/library"),
      });
      return;
    }
    case "toggle-theme": {
      ctx.cycleTheme();
      return;
    }
    case "close-canvas": {
      ctx.closeCanvas();
      return;
    }
    case "talk-to-myra": {
      if (ctx.tenantId === null) return;
      const result = await ensureMyraChannel(ctx.tenantId);
      if (result.kind === "ready") ctx.navigate(channelPath(result.channelId));
      return;
    }
    case "go-channels": {
      ctx.navigate(CHANNEL_PATH_PREFIX);
      return;
    }
    case "go-insights": {
      ctx.navigate("/insights");
      return;
    }
  }
}
