// The command palette's `>` action commands: everything the shell mock's
// `buildCmdkEntries` lists under "Commands" that this app can actually wire
// today. Each command dispatches the same event or calls the same function a
// visible button already uses — see the header actions in
// `shell/panel-contributions.tsx` for "New channel" / "New agent" /
// "New routine" / "New skill", `library-upload.ts` for "Upload artifact",
// and `myra-channel.ts` for "Talk to Myra". "New thread" is out of scope
// (killed by owner decision); "Toggle sidebar" has no equivalent yet — see
// AGENTS.md flags in the PR description.

import {
  CHANNEL_PATH_PREFIX,
  channelPath,
  isChannelPath,
} from "./channel-path";
import { ensureMyraChannel } from "./myra-channel";
import { requestLibraryUpload } from "./library-upload";

export type ActionCommandId =
  | "new-channel"
  | "new-agent"
  | "new-routine"
  | "new-skill"
  | "upload-artifact"
  | "toggle-theme"
  | "close-canvas"
  | "talk-to-myra"
  | "go-channels";

export type ActionCommand = {
  readonly id: ActionCommandId;
  readonly title: string;
  readonly subtitle: string;
};

/** Static catalog: id, title, subtitle. Matches the mock's action-command
 * titles, with "Install skill" relabeled "New skill" to match the shell's
 * current skills model (session-local drafts, not an install-from-catalog
 * flow — see `skills-session.ts`). */
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
  { id: "new-skill", title: "New skill", subtitle: "Bench capability" },
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
};

/**
 * Runs one action command. Navigation-plus-dispatch commands mirror the
 * exact sequence the visible header actions already use (dispatch the
 * create event, then navigate only if the target page is not already
 * mounted) so opening the same dialog from the palette behaves identically.
 */
export async function runActionCommand(
  id: ActionCommandId,
  ctx: ActionCommandContext,
): Promise<void> {
  switch (id) {
    case "new-channel": {
      window.dispatchEvent(new CustomEvent("workbench:chat:new-channel"));
      if (!isChannelPath(ctx.path)) ctx.navigate(channelPath(null));
      return;
    }
    case "new-agent": {
      window.dispatchEvent(new CustomEvent("workbench:agents:create"));
      if (ctx.path !== "/agents" && !ctx.path.startsWith("/agents/")) {
        ctx.navigate("/agents");
      }
      return;
    }
    case "new-routine": {
      window.dispatchEvent(new CustomEvent("workbench:routines:create"));
      if (ctx.path !== "/routines" && !ctx.path.startsWith("/routines/")) {
        ctx.navigate("/routines");
      }
      return;
    }
    case "new-skill": {
      window.dispatchEvent(new CustomEvent("workbench:skills:create"));
      if (ctx.path !== "/skills" && !ctx.path.startsWith("/skills/")) {
        ctx.navigate("/skills");
      }
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
  }
}
