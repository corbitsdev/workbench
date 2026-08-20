// The Personal Settings / Shared Settings section registry (CL-6089, CL-
// 6116): the grouping, ordering, icons, and tenancy gates every Interchange
// deployment gets when it mounts this package's settings surface. The
// single-concept collapse folded Personal/Workspace into one account-scoped
// group and one shared group — there is one workbench per account now, so
// a "workspace-scoped" setting and an "account-scoped" one are the same
// tenant's settings. Shared Settings is the multiplayer-sharing surface:
// it leads with what everyone inherits (shared keys/connections, then
// People), and tucks the access-control mechanics (Roles, Grants, Audit)
// under a collapsed Advanced disclosure — nobody should have to parse
// grants and roles just to find where a shared API key lives. Bench dies
// outright — there is no longer a second thing to name, distinct from the
// account, so its rename/purpose/icon form and member list have no home to
// keep them separate in. Conversation-scoped settings (agent, capabilities,
// history) live on the workbench's own settings surface
// (`@corbits/chat-ui`'s `WorkbenchSettingsSurface`, CL-6084) — not here.
// Consuming apps compose bench context and routing around
// `resolveSettingsSectionGroups` — the domain model of "what settings
// exist and who can see them" lives here, not in an app.

import { Bell, KeyRound, List, Shield, Star, User, Users } from "lucide-react";

import { AccountSection } from "./account-section";
import type { TenancyAccess } from "./access";
import { AuditSection } from "./audit-section";
import { ConnectionsSection } from "./connections-section";
import { GrantsSection } from "./grants-section";
import { NotificationsSection } from "./notifications-section";
import { PeopleSection } from "./people-section";
import { RolesSection } from "./roles-section";
import type { SettingsSection, SettingsSectionGroup } from "./shell";
import { SETTINGS_STRINGS } from "./strings";

type GatedSettingsSection = SettingsSection & {
  /** The `TenancyAccess` field this section is gated on. Omit for a
   * section every principal can see (Account sections, Audit). */
  readonly gate?: keyof TenancyAccess;
};

type SettingsSectionGroupDef = {
  readonly id: string;
  readonly label: string;
  readonly sections: readonly GatedSettingsSection[];
};

const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroupDef[] = [
  {
    id: "account",
    label: SETTINGS_STRINGS.groupAccountLabel,
    // No "Your agent" section here: it has no preference store to back it —
    // see agent-section.tsx's header comment for the re-add condition.
    // Account (General) leads — it is the reference's landing section
    // (account card, theme, timezone); notifications follow.
    sections: [
      {
        id: "account",
        title: SETTINGS_STRINGS.accountSectionTitle,
        icon: User,
        render: (ctx) => (
          <AccountSection
            {...(ctx.onSignOut !== undefined
              ? { onSignOut: ctx.onSignOut }
              : {})}
          />
        ),
      },
      {
        id: "chat",
        title: SETTINGS_STRINGS.notificationsSectionTitle,
        icon: Bell,
        render: () => <NotificationsSection />,
      },
    ],
  },
  {
    id: "everyone",
    label: SETTINGS_STRINGS.groupEveryoneLabel,
    sections: [
      {
        // Plugins (`/plugins`) is the canonical surface for discovering
        // and connecting a key; this section is management-only for keys
        // that already exist (rotate, name, revoke) — see connections-
        // section.tsx and the CL-6077 audit this reorganization follows.
        // Leads Shared Settings: a key added here is the thing everyone
        // creating workbenches in this tenancy inherits.
        id: "connections",
        title: SETTINGS_STRINGS.connectionsSectionTitle,
        icon: KeyRound,
        gate: "credentials",
        render: (ctx) => <ConnectionsSection tenantId={ctx.tenantId} />,
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
        advanced: true,
        render: (ctx) => <RolesSection tenantId={ctx.tenantId} />,
      },
      {
        id: "grants",
        title: SETTINGS_STRINGS.grantsSectionTitle,
        icon: Shield,
        gate: "grants",
        advanced: true,
        render: (ctx) => <GrantsSection tenantId={ctx.tenantId} />,
      },
      {
        id: "audit",
        title: SETTINGS_STRINGS.auditSectionTitle,
        icon: List,
        advanced: true,
        render: () => <AuditSection />,
      },
    ],
  },
];

/**
 * The Personal Settings / Shared Settings groups, with a section dropped entirely — never
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
 * Splices host-supplied sections into the Everyone group, at its front —
 * for domain sections that live outside this package (e.g. a host app's
 * Agents/Skills directories) but still belong in the same account-wide
 * nav. A host calling this must pass the same `extra` list to every
 * consumer (settings stage and its own section nav / col2), the same
 * discipline `resolveSettingsSectionGroups` itself documents, or the two
 * surfaces drift.
 */
export function insertEveryoneSections(
  groups: readonly SettingsSectionGroup[],
  extra: readonly SettingsSection[],
): readonly SettingsSectionGroup[] {
  if (extra.length === 0) return groups;
  return groups.map((group) => {
    if (group.id !== "everyone") return group;
    return { ...group, sections: [...extra, ...group.sections] };
  });
}
