// The settings surface's own section registry. Channels are tenants — their
// settings are a full stage surface (mock § Channel settings), grouped
// Shared / Personal / Danger zone, never a dialog with tabs.
//
// CL-6215: Agents is now the one place an agent participant's persona,
// capabilities, and history are edited — a click-through master-detail,
// not a separate "Myra" nav item duplicating the same editor for one
// hardcoded agent. Keys & plugins and Inference are gone as distinct
// sections: plugin/tool connections move to `plugins` (workbench-scoped,
// connections only — no inference-provider keys, which live in Shared
// Settings now); inference provider+model assignment moves onto the
// Agents detail view, per agent, fed from the tenant-wide provider pool.

import { CHAT_STRINGS } from "../strings";

export type ChannelSettingsSectionId =
  | "general"
  | "members"
  | "agents"
  | "plugins"
  | "capacity"
  | "notifications"
  | "danger";

export type ChannelSettingsSectionGroup = "shared" | "personal" | "danger";

export type ChannelSettingsSection = {
  readonly id: ChannelSettingsSectionId;
  readonly label: string;
  readonly group: ChannelSettingsSectionGroup;
};

/**
 * Sections available for a channel kind, in nav order. 1:1 chats drop
 * Members and Danger zone so the surface stays short (owner decision /
 * mock) — the same trim `channelSettingsTabs` applied before this file's
 * restructure.
 *
 * `isDm` additionally trims Agents: a DM (owner decision — "a DM = a
 * two-member channel tenancy with a trimmed settings surface") has no
 * agent participant and no agent to ever invite (its counterpart is
 * fixed at creation, exactly like an agent chat's is), so the section
 * — and the invite-agent affordance it renders — has nothing to show.
 * Defaults to `false` so every existing call site (agent chats,
 * channels) keeps exactly the section list it already had.
 *
 * `hasCapacity` gates Capacity the same way: this server's provisioner
 * either can or cannot run a workbench's agents on their own machine —
 * a fact this server decides once for everyone, never per conversation
 * — so a server without one has nothing here to configure. Defaults to
 * `false`, hidden until the caller confirms the feature is live.
 */
export function channelSettingsSections(
  channelKind: string,
  isDm = false,
  hasCapacity = false,
): readonly ChannelSettingsSection[] {
  const sections: ChannelSettingsSection[] = [
    {
      id: "general",
      label: CHAT_STRINGS.channelSettingsSectionGeneral,
      group: "shared",
    },
  ];
  if (channelKind !== "chat") {
    sections.push({
      id: "members",
      label: CHAT_STRINGS.channelSettingsSectionMembers,
      group: "shared",
    });
  }
  if (!(channelKind === "chat" && isDm)) {
    sections.push({
      id: "agents",
      label: CHAT_STRINGS.channelSettingsSectionAgents,
      group: "shared",
    });
  }
  sections.push(
    {
      id: "plugins",
      label: CHAT_STRINGS.channelSettingsSectionPlugins,
      group: "shared",
    },
    {
      id: "notifications",
      label: CHAT_STRINGS.channelSettingsSectionNotifications,
      group: "personal",
    },
  );
  if (hasCapacity) {
    sections.push({
      id: "capacity",
      label: CHAT_STRINGS.channelSettingsSectionCapacity,
      group: "shared",
    });
  }
  if (channelKind !== "chat") {
    sections.push({
      id: "danger",
      label: CHAT_STRINGS.channelSettingsSectionDanger,
      group: "danger",
    });
  }
  return sections;
}
