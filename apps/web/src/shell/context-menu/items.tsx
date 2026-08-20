// One item builder per target type. Every item here calls a real backend or
// a real, already-shipped shell affordance — nothing toast-only. A target
// whose mock counterpart had no working backend (mark-read, mute, archive,
// share) simply has no builder and so contributes no items.

import {
  patchWorkbenchSettings,
  profileSubjectFromParticipant,
} from "@corbits/chat-ui";
import type { ProfileSubject } from "@corbits/chat-ui";
import { contextMenuItem, contextMenuSeparator } from "@corbits/context-menu";
import type { ContextMenu, ContextMenuEntry } from "@corbits/context-menu";
import {
  ExternalLink,
  Hash,
  Link as LinkIcon,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  PlayCircle,
  Search,
  SlidersHorizontal,
  SunMoon,
  UserRound,
} from "lucide-react";
import { toast } from "@corbits/react-ui";

import { workbenchPath } from "../../workbench-path";
import { requestWorkbenchRename } from "../../workbench-rename-events";
import { requestOpenCommandPalette } from "../../command-palette-events";
import { runRoutineNow } from "../../routines-api";
import { SETTINGS_PATH } from "../../routes";
import type { ShellContextMenuTarget } from "./targets";

export type ShellContextMenuActions = {
  readonly tenantId: string | null;
  readonly navigate: (to: string) => void;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly cycleTheme: () => void;
  readonly signOut: () => void;
};

async function copyLink(path: string, label: string): Promise<void> {
  const url = `${window.location.origin}${path}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(`${label} link copied`);
  } catch {
    toast("Couldn't copy the link");
  }
}

function workbenchMenu(
  target: Extract<ShellContextMenuTarget, { type: "workbench" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const entries: ContextMenuEntry[] = [
    contextMenuItem({
      id: "rename",
      label: "Rename conversation",
      icon: <Pencil />,
      onSelect: () => requestWorkbenchRename(target.id),
    }),
  ];
  if (actions.tenantId !== null) {
    const tenantId = actions.tenantId;
    entries.push(
      contextMenuItem({
        id: "pin",
        label: target.pinned ? "Unpin conversation" : "Pin conversation",
        icon: target.pinned ? <PinOff /> : <Pin />,
        onSelect: () => {
          void patchWorkbenchSettings(tenantId, target.id, {
            "chat/pinned": !target.pinned,
          }).then(
            () =>
              toast(
                target.pinned ? "Conversation unpinned" : "Conversation pinned",
              ),
            () => toast("Couldn't update the conversation"),
          );
        },
      }),
    );
  }
  entries.push(
    contextMenuSeparator,
    contextMenuItem({
      id: "copy-link",
      label: "Copy link",
      icon: <LinkIcon />,
      onSelect: () => void copyLink(workbenchPath(target.id), target.title),
    }),
  );
  return { label: target.title, entries };
}

function profileMenu(
  target: Extract<ShellContextMenuTarget, { type: "profile" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const subject = profileSubjectFromParticipant({
    address: target.address,
    handle: target.handle,
  });
  return {
    label: subject.displayName,
    entries: [
      contextMenuItem({
        id: "open-profile",
        label: "Open profile",
        icon: <UserRound />,
        onSelect: () => actions.openProfile(subject),
      }),
    ],
  };
}

function routineMenu(
  target: Extract<ShellContextMenuTarget, { type: "routine" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const path = `/routines/${encodeURIComponent(target.id)}`;
  const entries: ContextMenuEntry[] = [
    contextMenuItem({
      id: "open",
      label: "Open routine",
      icon: <ExternalLink />,
      onSelect: () => actions.navigate(path),
    }),
  ];
  if (actions.tenantId !== null) {
    const tenantId = actions.tenantId;
    entries.push(
      contextMenuItem({
        id: "run-now",
        label: "Run now",
        icon: <PlayCircle />,
        onSelect: () => {
          void runRoutineNow(tenantId, target.id).then(
            () => toast(`${target.name} started`),
            () => toast("Couldn't start the routine"),
          );
        },
      }),
    );
  }
  entries.push(
    contextMenuSeparator,
    contextMenuItem({
      id: "copy-link",
      label: "Copy link",
      icon: <LinkIcon />,
      onSelect: () => void copyLink(path, target.name),
    }),
  );
  return { label: target.name, entries };
}

function insightsRunMenu(
  target: Extract<ShellContextMenuTarget, { type: "insights-run" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const path = `/insights/runs/${encodeURIComponent(target.id)}`;
  return {
    entries: [
      contextMenuItem({
        id: "open",
        label: "Open run",
        icon: <ExternalLink />,
        onSelect: () => actions.navigate(path),
      }),
      contextMenuItem({
        id: "copy-link",
        label: "Copy link",
        icon: <LinkIcon />,
        onSelect: () => void copyLink(path, "Run"),
      }),
    ],
  };
}

function accountMenu(actions: ShellContextMenuActions): ContextMenu {
  return {
    label: "Account",
    entries: [
      contextMenuItem({
        id: "settings",
        label: "Settings",
        icon: <SlidersHorizontal />,
        onSelect: () => actions.navigate(SETTINGS_PATH),
      }),
      contextMenuSeparator,
      contextMenuItem({
        id: "sign-out",
        label: "Sign out",
        icon: <LogOut />,
        onSelect: () => actions.signOut(),
      }),
    ],
  };
}

function shellMenu(actions: ShellContextMenuActions): ContextMenu {
  return {
    label: "Workbench",
    entries: [
      contextMenuItem({
        id: "search",
        label: "Search…",
        icon: <Search />,
        onSelect: () => requestOpenCommandPalette(),
      }),
      contextMenuItem({
        id: "workbenches",
        label: "Go to workbenches",
        icon: <Hash />,
        onSelect: () => actions.navigate(workbenchPath(null)),
      }),
      contextMenuSeparator,
      contextMenuItem({
        id: "theme",
        label: "Toggle theme",
        icon: <SunMoon />,
        onSelect: () => actions.cycleTheme(),
      }),
    ],
  };
}

export function shellContextMenuFor(
  target: ShellContextMenuTarget,
  actions: ShellContextMenuActions,
): ContextMenu {
  switch (target.type) {
    case "workbench":
      return workbenchMenu(target, actions);
    case "profile":
      return profileMenu(target, actions);
    case "routine":
      return routineMenu(target, actions);
    case "insights-run":
      return insightsRunMenu(target, actions);
    case "account":
      return accountMenu(actions);
    case "shell":
      return shellMenu(actions);
  }
}
