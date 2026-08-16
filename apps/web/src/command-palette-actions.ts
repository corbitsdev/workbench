// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Most create commands use the off-route-safe pending-flag pattern
// `library-upload.ts` established: the palette can fire from any page,
// before the target page (and its window-event listener) has mounted, so a
// same-tick `dispatchEvent` would be a race the listener always loses.
// `pending-dialog-request.ts` generalizes that pattern; the target
// pages/sections (skills-settings-section.tsx, chat-page.tsx) consume the
// pending flag on mount. Skills moved from its own route into a Settings
// section (CL-5990) — "New skill" lands on `/settings/skills`. The global
// agents settings tab was later removed (CL-6121); "New agent" now mints a
// fresh workbench, same as "New workbench". "New thread" is out of scope
// (killed by owner decision).
//
// "New routine" (CL-6125) needs none of that: it opens the canvas column's
// routine pane, and canvas state lives in `ShellChromeProvider` above every
// route, not inside a page that has to mount first — so `requestNewRoutine`
// just calls the caller's own `openRoutine` (from `useOpenRoutineInCanvas`)
// synchronously, no pending flag, no window event.

import { createPendingDialogRequest } from "@corbits/shell-layout";
import {
  CHANNEL_PATH_PREFIX,
  channelPath,
  isChannelPath,
} from "./channel-path";
import { ensureMyraChannel } from "./myra-channel";
import { requestLibraryUpload } from "./library-upload";
import type { RoutinePanelSubject } from "./shell/canvas-availability";

export const NEW_CHANNEL_EVENT = "workbench:chat:new-channel";
export const NEW_SKILL_EVENT = "workbench:skills:create";
export const NEW_TASK_EVENT = "workbench:tasks:create";

const newChannelRequest = createPendingDialogRequest();
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
/** Consumed by skills-settings-section.tsx on mount. */
export const consumePendingNewSkill = newSkillRequest.consumePending;
/** Consumed by inbox-page.tsx on mount — the task composer opens there
 * (CL-6049): a task is spawn-and-return, its result reaches the Inbox,
 * so that's the one page that owns the affordance for starting one. */
export const consumePendingNewTask = newTaskRequest.consumePending;

/**
 * Opens the routine panel, navigating to `/routines` first so the list is
 * visible behind the canvas — the same landing spot the old dialog's
 * "New routine" always opened onto. Every "start a routine" affordance in
 * the app (the command palette, the chat header, "Make this a routine")
 * funnels through this one function.
 */
export function requestNewRoutine(args: {
  readonly navigateToRoutines: () => void;
  readonly openRoutine: (subject: RoutinePanelSubject) => void;
  readonly initialName?: string;
  readonly initialInstruction?: string;
}): void {
  args.navigateToRoutines();
  args.openRoutine({
    routineId: null,
    ...(args.initialName !== undefined ? { initialName: args.initialName } : {}),
    ...(args.initialInstruction !== undefined
      ? { initialInstruction: args.initialInstruction }
      : {}),
  });
}

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
  newChannelRequest.resetPending();
  newSkillRequest.resetPending();
  newTaskRequest.resetPending();
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
  readonly openRoutine: (subject: RoutinePanelSubject) => void;
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
        navigateToRoutines: () => ctx.navigate("/routines"),
        openRoutine: ctx.openRoutine,
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
