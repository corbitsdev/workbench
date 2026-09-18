// "New skill" uses the off-route-safe pending-flag pattern from
// `pending-dialog-request.ts`, since the palette can fire before the
// target page's listener mounts. "New workbench" has no such race — it
// navigates straight to the template picker. "New task"/"New thread" are
// out of scope (owner decision).

import { createPendingDialogRequest } from "@/shell/layout";
import { CHAT_STRINGS } from "@/chat";
import { WORKBENCH_PATH_PREFIX } from "./workbench-path";
import { NEW_WORKBENCH_PATH } from "./routes";
import { NEW_CHAT_PATH } from "./chat-path";
import { requestLibraryUpload } from "./library-upload";
import { openFirstRunTour } from "./shell/first-run-tour-store";

export const NEW_SKILL_EVENT = "workbench:skills:create";

const newSkillRequest = createPendingDialogRequest();

/** Consumed by skills-settings-section.tsx on mount. */
export const consumePendingNewSkill = newSkillRequest.consumePending;

/** Test helper — drop leftover pending state between cases. */
export function resetPendingDialogRequests(): void {
  newSkillRequest.resetPending();
}

export type ActionCommandId =
  | "new-workbench"
  | "new-skill"
  | "upload-artifact"
  | "toggle-theme"
  | "close-canvas"
  | "talk-to-myra"
  | "go-workbenches"
  | "take-tour";

export type ActionCommand = {
  readonly id: ActionCommandId;
  readonly title: string;
  readonly subtitle: string;
};

// "Install skill" relabeled "New skill": a person authors a skill into
// the workbench's own registry rather than installing from a catalog.
export const ACTION_COMMANDS: readonly ActionCommand[] = [
  {
    id: "new-workbench",
    title: CHAT_STRINGS.newWorkbenchAction,
    subtitle: "Start a new workbench",
  },
  { id: "new-skill", title: "New skill", subtitle: "Workbench capability" },
  {
    id: "upload-artifact",
    title: "Upload artifact",
    subtitle: "Artifacts · open dialog",
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
    id: "go-workbenches",
    title: "Go to workbenches",
    subtitle: "Home · conversation list",
  },
  {
    id: "take-tour",
    title: "Take the tour",
    subtitle: "Guided walkthrough of the shell",
  },
];

export type ActionCommandContext = {
  readonly path: string;
  readonly navigate: (to: string) => void;
  readonly tenantId: string | null;
  readonly cycleTheme: () => void;
  readonly closeCanvas: () => void;
};

// "new-skill" goes through a pending flag off-route, so the target page's
// mount effect opens the dialog instead of racing a dispatch.
export async function runActionCommand(
  id: ActionCommandId,
  ctx: ActionCommandContext,
): Promise<void> {
  switch (id) {
    case "new-workbench": {
      ctx.navigate(NEW_WORKBENCH_PATH);
      return;
    }
    case "new-skill": {
      newSkillRequest.request({
        alreadyOnTargetRoute: ctx.path === "/skills" || ctx.path.startsWith("/skills/"),
        navigateToTargetRoute: () => ctx.navigate("/skills"),
        dispatch: () => window.dispatchEvent(new CustomEvent(NEW_SKILL_EVENT)),
      });
      return;
    }
    case "upload-artifact": {
      requestLibraryUpload({
        alreadyOnLibrary: ctx.path === "/artifacts" || ctx.path.startsWith("/artifacts/"),
        navigateToLibrary: () => ctx.navigate("/artifacts"),
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
      // A chat with Myra is a mail thread now, composed on /chats/new.
      ctx.navigate(NEW_CHAT_PATH);
      return;
    }
    case "go-workbenches": {
      ctx.navigate(WORKBENCH_PATH_PREFIX);
      return;
    }
    case "take-tour": {
      openFirstRunTour();
      return;
    }
  }
}
