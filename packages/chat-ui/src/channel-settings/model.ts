// The settings surface's own section registry. Channels are tenants — their
// settings are a full stage surface (mock § Channel settings), grouped
// Shared / Personal / Danger zone, never a dialog with tabs.

import { CHAT_STRINGS } from "../strings";

export type ChannelSettingsSectionId =
  "general" | "members" | "agents" | "access" | "notifications" | "danger";

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
 */
export function channelSettingsSections(
  channelKind: string,
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
  sections.push(
    {
      id: "agents",
      label: CHAT_STRINGS.channelSettingsSectionAgents,
      group: "shared",
    },
    {
      id: "access",
      label: CHAT_STRINGS.channelSettingsSectionAccess,
      group: "shared",
    },
    {
      id: "notifications",
      label: CHAT_STRINGS.channelSettingsSectionNotifications,
      group: "personal",
    },
  );
  if (channelKind !== "chat") {
    sections.push({
      id: "danger",
      label: CHAT_STRINGS.channelSettingsSectionDanger,
      group: "danger",
    });
  }
  return sections;
}
