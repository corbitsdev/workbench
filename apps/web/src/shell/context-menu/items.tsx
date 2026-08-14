// One item builder per target type. Every item here calls a real backend or
// a real, already-shipped shell affordance — nothing toast-only. A target
// whose mock counterpart had no working backend (mark-read, mute, archive,
// share) simply has no builder and so contributes no items.

import {
  patchChannelSettings,
  profileSubjectFromParticipant,
} from "@corbits/chat-ui";
import type { ProfileSubject } from "@corbits/chat-ui";
import { contextMenuItem, contextMenuSeparator } from "@corbits/context-menu";
import type { ContextMenu, ContextMenuEntry } from "@corbits/context-menu";
import {
  ExternalLink,
  Hash,
  Link as LinkIcon,
  Pencil,
  Pin,
  PinOff,
  PlayCircle,
  Search,
  SunMoon,
  UserRound,
} from "lucide-react";
import { toast } from "@corbits/react-ui";

import { channelPath } from "../../channel-path";
import { requestChannelRename } from "../../channel-rename-events";
import { requestOpenCommandPalette } from "../../command-palette-events";
import { runRoutineNow } from "../../routines-api";
import { inboxPathForFilter } from "../panel-contributions";
import type { ShellContextMenuTarget } from "./targets";

export type ShellContextMenuActions = {
  readonly tenantId: string | null;
  readonly navigate: (to: string) => void;
  readonly openProfile: (subject: ProfileSubject) => void;
  readonly cycleTheme: () => void;
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

function channelMenu(
  target: Extract<ShellContextMenuTarget, { type: "channel" }>,
  actions: ShellContextMenuActions,
): ContextMenu {
  const entries: ContextMenuEntry[] = [
    contextMenuItem({
      id: "rename",
      label: "Rename channel",
      icon: <Pencil />,
      onSelect: () => requestChannelRename(target.id),
    }),
  ];
  if (actions.tenantId !== null) {
    const tenantId = actions.tenantId;
    entries.push(
      contextMenuItem({
        id: "pin",
        label: target.pinned ? "Unpin channel" : "Pin channel",
        icon: target.pinned ? <PinOff /> : <Pin />,
        onSelect: () => {
          void patchChannelSettings(tenantId, target.id, {
            "chat/pinned": !target.pinned,
          }).then(
            () => toast(target.pinned ? "Channel unpinned" : "Channel pinned"),
            () => toast("Couldn't update the channel"),
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
      onSelect: () => void copyLink(channelPath(target.id), target.title),
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

function inboxFilterMenu(
  target: Extract<ShellContextMenuTarget, { type: "inbox-filter" }>,
): ContextMenu {
  const path = inboxPathForFilter(target.filter);
  return {
    entries: [
      contextMenuItem({
        id: "copy-link",
        label: "Copy link",
        icon: <LinkIcon />,
        onSelect: () => void copyLink(path, "Inbox filter"),
      }),
    ],
  };
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
        id: "channels",
        label: "Go to channels",
        icon: <Hash />,
        onSelect: () => actions.navigate(channelPath(null)),
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
    case "channel":
      return channelMenu(target, actions);
    case "profile":
      return profileMenu(target, actions);
    case "routine":
      return routineMenu(target, actions);
    case "inbox-filter":
      return inboxFilterMenu(target);
    case "insights-run":
      return insightsRunMenu(target, actions);
    case "shell":
      return shellMenu(actions);
  }
}
