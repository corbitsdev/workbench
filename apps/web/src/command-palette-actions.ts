// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Skills and tasks still use the off-route-safe pending-flag
// pattern `library-upload.ts` established: the palette can fire from any
// page, before the target page (and its window-event listener) has
// mounted, so a same-tick `dispatchEvent` would be a race the listener
// always loses. `pending-dialog-request.ts` generalizes that pattern; the
// target pages/sections (skills-settings-section.tsx, inbox-page.tsx)
// consume the pending flag on mount. Skills moved from its own route into
// a Settings section (CL-5990) — "New skill" lands on `/settings/skills`.
//
// Workbench creation is not one of those — there is no dialog to race, no
// page to mount first: one click mints a fresh Myra workbench and
// navigates straight into it (CL-6138, superseding the CL-6089/CL-6121
// picker-and-dialog design). "new-channel" and "new-agent" both funnel
// through `requestNewWorkbench`, the same one-creation-verb hop the
// sidebar's own "+" control uses. "New thread" is out of scope (killed by
// owner decision).
//
// "New routine" (CL-6125) needs none of the pending-flag machinery either:
// it opens the canvas column's routine pane, and canvas state lives in
// `ShellChromeProvider` above every route, not inside a page that has to
// mount first — so `requestNewRoutine` just calls the caller's own
// `openRoutine` (from `useOpenRoutineInCanvas`) synchronously, no pending
// flag, no window event.

import { toast } from "@corbits/react-ui";

import { createPendingDialogRequest } from "@corbits/shell-layout";
import { CHANNEL_PATH_PREFIX, channelPath } from "./channel-path";
import { createAgentAndLaunch } from "./instant-agent-create";
import { ensureMyraChannel } from "./myra-channel";
import { requestLibraryUpload } from "./library-upload";
import type { RoutinePanelSubject } from "./shell/canvas-availability";

export const NEW_SKILL_EVENT = "workbench:skills:create";
export const NEW_TASK_EVENT = "workbench:tasks:create";

const newSkillRequest = createPendingDialogRequest();
const newTaskRequest = createPendingDialogRequest();

/**
 * The one creation verb: mints a fresh Myra workbench and navigates
 * straight into it — no dialog, no picker. Every "create a workbench"
 * affordance in the app (the sidebar's own "+" control, the command
 * palette's "New workbench", the routines page's "no taskable agents"
 * empty state) funnels through this one function. Fails closed with a
 * toast rather than a silent no-op, e.g. a bench that predates seeding
 * and has no default setup template.
 */
export async function requestNewWorkbench(args: {
  readonly tenantId: string | null;
  readonly navigate: (to: string) => void;
}): Promise<void> {
  if (args.tenantId === null) return;
  try {
    await createAgentAndLaunch(args.tenantId, args.navigate);
  } catch {
    toast("Couldn't create the workbench — try again.");
  }
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
    ...(args.initialName !== undefined
      ? { initialName: args.initialName }
      : {}),
    ...(args.initialInstruction !== undefined
      ? { initialInstruction: args.initialInstruction }
      : {}),
  });
}

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
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
    subtitle: "Mint a fresh workbench with Myra",
  },
  {
    id: "new-agent",
    title: "New workbench",
    subtitle: "Mint a fresh workbench with Myra",
  },
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
 * Runs one action command. "new-channel" and "new-agent" both mint
 * directly — see `requestNewWorkbench`'s doc; "new-skill" and "new-task"
 * still go through a pending flag when the palette fires them off-route
 * (see the module doc), so the target page's own mount effect opens the
 * dialog instead of a dispatch racing against that page's not-yet-mounted
 * listener.
 */
export async function runActionCommand(
  id: ActionCommandId,
  ctx: ActionCommandContext,
): Promise<void> {
  switch (id) {
    case "new-channel":
    case "new-agent": {
      await requestNewWorkbench({
        tenantId: ctx.tenantId,
        navigate: ctx.navigate,
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
