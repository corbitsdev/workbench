// The settings surface's own section registry. Channels are tenants — their
// settings are a full stage surface (mock § Channel settings), grouped
// Shared / Personal / Danger zone, never a dialog with tabs.

import { CHAT_STRINGS } from "../strings";

export type ChannelSettingsSectionId =
  | "general"
  | "members"
  | "agents"
  | "assistant"
  | "access"
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
 * `hasAgent` gates Assistant on its own, narrower signal: whether this
 * channel actually carries an agent participant right now, not merely
 * whether one could ever be invited. Unlike Agents (always offered,
 * empty or not, for anything that isn't a human DM), Assistant has
 * nothing to show — no name, no instructions — until a real agent is
 * there to edit. Defaults to `false`, an inert control being worse
 * than a hidden one.
 */
export function channelSettingsSections(
  channelKind: string,
  isDm = false,
  hasAgent = false,
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
  if (hasAgent) {
    sections.push({
      id: "assistant",
      label: CHAT_STRINGS.channelSettingsSectionAssistant,
      group: "shared",
    });
  }
  sections.push(
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
