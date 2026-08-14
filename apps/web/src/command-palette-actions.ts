// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Each create command uses the same off-route-safe pending-flag
// pattern `library-upload.ts` already established: the palette can fire
// from any page, before the target page (and its window-event listener) has
// mounted, so a same-tick `dispatchEvent` would be a race the listener
// always loses. `pending-dialog-request.ts` generalizes that pattern; the
// target pages/sections (agents-settings-section.tsx, routines-page.tsx,
// skills-settings-section.tsx, chat-page.tsx) consume the pending flag on
// mount. Agents and Skills moved from their own routes into Settings
// sections (CL-5990) — "New agent"/"New skill" now land on
// `/settings/agents` / `/settings/skills`. "New thread" is out of scope
// (killed by owner decision); "Toggle sidebar" drives the same `toggleCol2`
// col2's own control uses (see `stage-chrome.ts`).

import {
  CHANNEL_PATH_PREFIX,
  channelPath,
  isChannelPath,
} from "./channel-path";
import { ensureMyraChannel } from "./myra-channel";
import { requestLibraryUpload } from "./library-upload";
import { createPendingDialogRequest } from "./pending-dialog-request";

export const NEW_CHANNEL_EVENT = "workbench:chat:new-channel";
export const NEW_AGENT_EVENT = "workbench:agents:create";
export const NEW_ROUTINE_EVENT = "workbench:routines:create";
export const NEW_SKILL_EVENT = "workbench:skills:create";

const newChannelRequest = createPendingDialogRequest();
const newAgentRequest = createPendingDialogRequest();
const newRoutineRequest = createPendingDialogRequest();
const newSkillRequest = createPendingDialogRequest();

/** Consumed by chat-page.tsx on mount. */
export const consumePendingNewChannel = newChannelRequest.consumePending;
/** Consumed by agents-settings-section.tsx on mount. */
export const consumePendingNewAgent = newAgentRequest.consumePending;
/** Consumed by routines-page.tsx on mount. */
export const consumePendingNewRoutine = newRoutineRequest.consumePending;
/** Consumed by skills-settings-section.tsx on mount. */
export const consumePendingNewSkill = newSkillRequest.consumePending;

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

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
  newChannelRequest.resetPending();
  newAgentRequest.resetPending();
  newRoutineRequest.resetPending();
  newSkillRequest.resetPending();
}

export type ActionCommandId =
  | "new-channel"
  | "new-agent"
  | "new-routine"
  | "new-skill"
  | "upload-artifact"
  | "toggle-theme"
  | "close-canvas"
  | "toggle-sidebar"
  | "talk-to-myra"
  | "go-channels";

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
    title: "New channel",
    subtitle: "Create conversation",
  },
  { id: "new-agent", title: "New agent", subtitle: "Create with v1" },
  {
    id: "new-routine",
    title: "New routine",
    subtitle: "Schedule · trigger · demand",
  },
  { id: "new-skill", title: "New skill", subtitle: "Workbench capability" },
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
    id: "toggle-sidebar",
    title: "Toggle sidebar",
    subtitle: "Show or hide context column",
  },
  {
    id: "talk-to-myra",
    title: "Talk to Myra",
    subtitle: "Open personal agent channel",
  },
  {
    id: "go-channels",
    title: "Go to channels",
    subtitle: "Home · conversation list",
  },
];

export type ActionCommandContext = {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly tenantId: string | null;
  readonly cycleTheme: () => void;
  readonly closeCanvas: () => void;
  readonly toggleCol2: () => void;
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
      newChannelRequest.request({
        alreadyOnTargetRoute: isChannelPath(ctx.path),
        navigateToTargetRoute: () => ctx.navigate(channelPath(null)),
        dispatch: () =>
          window.dispatchEvent(new CustomEvent(NEW_CHANNEL_EVENT)),
      });
      return;
    }
    case "new-agent": {
      newAgentRequest.request({
        alreadyOnTargetRoute:
          ctx.path === "/settings/agents" ||
          ctx.path.startsWith("/settings/agents/"),
        navigateToTargetRoute: () => ctx.navigate("/settings/agents"),
        dispatch: () => window.dispatchEvent(new CustomEvent(NEW_AGENT_EVENT)),
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
    case "toggle-sidebar": {
      ctx.toggleCol2();
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
  }
}
