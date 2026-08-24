// The settings surface's own section registry. Workbenches are tenants — their
// settings are a full stage surface (mock § Workbench settings), grouped
// Shared / Personal / Danger zone, never a dialog with tabs.
//
// CL-6215: Agents is now the one place an agent participant's persona,
// capabilities, and history are edited — a click-through master-detail,
// not a separate "Myra" nav item duplicating the same editor for one
// hardcoded agent. Keys & plugins and Inference are gone as distinct
// sections: inference provider+model assignment moves onto the Agents
// detail view, per agent, fed from the tenant-wide provider pool.
//
// Plugins are global-only for now (owner ruling): the workbench-scoped
// `plugins` section that used to live here is removed — connect/manage
// plugins from the bench-level Plugins page instead. Per-workbench
// credential rows written by that old section are left in place (nothing
// reads or writes them now); see the Plugins page for the surviving
// surface.

import { CHAT_STRINGS } from "../strings";

export type WorkbenchSettingsSectionId =
  "general" | "members" | "agents" | "capacity" | "notifications" | "danger";

/** Every `WorkbenchSettingsSectionId`, for validating a section id read
 * off a URL — a route parser needs this list to narrow untrusted input
 * without an unchecked cast; `sectionsForWorkbenchKind` below is a
 * per-kind subset that doesn't fit that job. */
export const WORKBENCH_SETTINGS_SECTION_IDS: readonly WorkbenchSettingsSectionId[] =
  ["general", "members", "agents", "capacity", "notifications", "danger"];

export function isWorkbenchSettingsSectionId(
  value: string,
): value is WorkbenchSettingsSectionId {
  return (WORKBENCH_SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export type WorkbenchSettingsSectionGroup = "shared" | "personal" | "danger";

export type WorkbenchSettingsSection = {
  readonly id: WorkbenchSettingsSectionId;
  readonly label: string;
  readonly group: WorkbenchSettingsSectionGroup;
};

/**
 * Outcome of asking this server whether it can offer dedicated capacity.
 *
 * - `"available"` — provisioner confirmed present; show Capacity.
 * - `"unavailable"` — provisioner confirmed absent; hide Capacity.
 * - `"unknown"` — probe failed or has not resolved; must not be treated
 *   as `"unavailable"` (CL-6828). A transient miss would permanently
 *   omit the section if folded to false.
 */
export type CapacityProbeState = "unknown" | "available" | "unavailable";

/** Capacity stays in the nav unless the probe confirmed no provisioner. */
export function capacitySectionVisible(probe: CapacityProbeState): boolean {
  return probe !== "unavailable";
}

/**
 * Sections available for a workbench kind, in nav order. 1:1 chats drop
 * Members and Danger zone so the surface stays short (owner decision /
 * mock) — the same trim `workbenchSettingsTabs` applied before this file's
 * restructure.
 *
 * `isDm` additionally trims Agents: a DM (owner decision — "a DM = a
 * two-member workbench tenancy with a trimmed settings surface") has no
 * agent participant and no agent to ever invite (its counterpart is
 * fixed at creation, exactly like an agent chat's is), so the section
 * — and the invite-agent affordance it renders — has nothing to show.
 * Defaults to `false` so every existing call site (agent chats,
 * workbenches) keeps exactly the section list it already had.
 *
 * `capacityProbe` gates Capacity: hide only when the probe confirmed
 * this server has no provisioner. Defaults to `"unavailable"` (hidden)
 * until the caller supplies a real probe outcome — never fold a failed
 * probe into that default.
 */
export function workbenchSettingsSections(
  workbenchKind: string,
  isDm = false,
  capacityProbe: CapacityProbeState = "unavailable",
): readonly WorkbenchSettingsSection[] {
  const sections: WorkbenchSettingsSection[] = [
    {
      id: "general",
      label: CHAT_STRINGS.workbenchSettingsSectionGeneral,
      group: "shared",
    },
  ];
  if (workbenchKind !== "chat") {
    sections.push({
      id: "members",
      label: CHAT_STRINGS.workbenchSettingsSectionMembers,
      group: "shared",
    });
  }
  if (!(workbenchKind === "chat" && isDm)) {
    sections.push({
      id: "agents",
      label: CHAT_STRINGS.workbenchSettingsSectionAgents,
      group: "shared",
    });
  }
  sections.push({
    id: "notifications",
    label: CHAT_STRINGS.workbenchSettingsSectionNotifications,
    group: "personal",
  });
  if (capacitySectionVisible(capacityProbe)) {
    sections.push({
      id: "capacity",
      label: CHAT_STRINGS.workbenchSettingsSectionCapacity,
      group: "shared",
    });
  }
  if (workbenchKind !== "chat") {
    sections.push({
      id: "danger",
      label: CHAT_STRINGS.workbenchSettingsSectionDanger,
      group: "danger",
    });
  }
  return sections;
}
