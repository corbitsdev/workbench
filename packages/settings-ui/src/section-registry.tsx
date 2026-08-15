// The Personal / Workspace section registry: the grouping, ordering, icons,
// and tenancy gates every Interchange deployment gets when it mounts this
// package's settings surface. Consuming apps compose bench context and
// routing around `resolveSettingsSectionGroups` — the domain model of "what
// settings exist and who can see them" lives here, not in an app.

import {
  Bell,
  Home,
  List,
  Plug,
  Shield,
  Star,
  User,
  Users,
} from "lucide-react";

import { AccountSection } from "./account-section";
import type { TenancyAccess } from "./access";
import { AuditSection } from "./audit-section";
import { BenchSection } from "./bench-section";
import { ChatSection } from "./chat-section";
import { ConnectionsSection } from "./connections-section";
import { GrantsSection } from "./grants-section";
import { NotificationsSection } from "./notifications-section";
import { PeopleSection } from "./people-section";
import { RolesSection } from "./roles-section";
import type { SettingsSection, SettingsSectionGroup } from "./shell";
import { SETTINGS_STRINGS } from "./strings";

type GatedSettingsSection = SettingsSection & {
  /** The `TenancyAccess` field this section is gated on. Omit for a
   * section every principal can see (Personal sections, Bench, Audit). */
  readonly gate?: keyof TenancyAccess;
};

type SettingsSectionGroupDef = {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly GatedSettingsSection[];
};

const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroupDef[] = [
  {
    id: "personal",
    label: SETTINGS_STRINGS.groupPersonalLabel,
    // No "Your agent" section here: it has no preference store to back it —
    // see agent-section.tsx's header comment for the re-add condition.
    sections: [
      {
        id: "chat",
        title: SETTINGS_STRINGS.notificationsSectionTitle,
        icon: Bell,
        render: () => <NotificationsSection />,
      },
      {
        id: "account",
        title: SETTINGS_STRINGS.accountSectionTitle,
        icon: User,
        render: () => <AccountSection />,
      },
    ],
  },
  {
    id: "workspace",
    label: SETTINGS_STRINGS.groupWorkspaceLabel,
    sections: [
      {
        id: "bench",
        title: SETTINGS_STRINGS.benchSectionTitle,
        icon: Home,
        render: (ctx) => (
          <>
            <BenchSection tenantId={ctx.tenantId} />
            <ChatSection tenantId={ctx.tenantId} />
          </>
        ),
      },
      {
        id: "people",
        title: SETTINGS_STRINGS.peopleSectionTitle,
        icon: Users,
        gate: "people",
        render: (ctx) => <PeopleSection tenantId={ctx.tenantId} />,
      },
      {
        id: "roles",
        title: SETTINGS_STRINGS.rolesSectionTitle,
        icon: Star,
        gate: "roles",
        render: (ctx) => <RolesSection tenantId={ctx.tenantId} />,
      },
      {
        id: "grants",
        title: SETTINGS_STRINGS.grantsSectionTitle,
        icon: Shield,
        gate: "grants",
        render: (ctx) => <GrantsSection tenantId={ctx.tenantId} />,
      },
      {
        id: "connections",
        title: SETTINGS_STRINGS.connectionsSectionTitle,
        icon: Plug,
        gate: "credentials",
        render: (ctx) => <ConnectionsSection tenantId={ctx.tenantId} />,
      },
      {
        id: "audit",
        title: SETTINGS_STRINGS.auditSectionTitle,
        icon: List,
        render: () => <AuditSection />,
      },
    ],
  },
];

/**
 * The Personal / Workspace groups, with a section dropped entirely — never
 * rendered disabled — until its `access[gate]` probe resolves `allowed`.
 * Both the settings stage and a host's own section nav (e.g. col2) should
 * read from this single registry so they can never drift.
 */
export function resolveSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  return SETTINGS_SECTION_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    sections: group.sections
      .filter(
        (section) =>
          section.gate === undefined || access[section.gate] === "allowed",
      )
      .map(({ gate: _gate, ...section }) => section),
  }));
}

/**
 * Splices host-supplied sections into the Workspace group, right after
 * "bench" — for domain sections that live outside this package (e.g. a
 * host app's Agents/Skills directories) but still belong in the same
 * Workspace nav. A host calling this must pass the same `extra` list to
 * every consumer (settings stage and its own section nav / col2), the same
 * discipline `resolveSettingsSectionGroups` itself documents, or the two
 * surfaces drift.
 */
export function insertWorkspaceSections(
  groups: readonly SettingsSectionGroup[],
  extra: readonly SettingsSection[],
): readonly SettingsSectionGroup[] {
  if (extra.length === 0) return groups;
  return groups.map((group) => {
    if (group.id !== "workspace") return group;
    const benchIndex = group.sections.findIndex(
      (section) => section.id === "bench",
    );
    const insertAt = benchIndex === -1 ? 0 : benchIndex + 1;
    return {
      ...group,
      sections: [
        ...group.sections.slice(0, insertAt),
        ...extra,
        ...group.sections.slice(insertAt),
      ],
    };
  });
}
