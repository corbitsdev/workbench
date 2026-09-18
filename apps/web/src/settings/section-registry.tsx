// See docs/settings-sections.md for the grouping rationale.

import { Cpu, Key, ListBullets, Shield, Star, User, Users } from "@/lib/icons";

import { AccountSection } from "./account-section";
import type { TenancyAccess } from "./access";
import { AuditSection } from "./audit-section";
import { CredentialsSection } from "./credentials-section";
import { GrantsSection } from "./grants-section";
import { ModelsSection } from "./models-section";
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
    // No "Your agent"/Notifications sections: no preference store backs
    // them yet — see notifications-section.tsx for the re-add condition.
    sections: [
      {
        id: "account",
        title: SETTINGS_STRINGS.accountSectionTitle,
        icon: User,
        render: (ctx) => (
          <AccountSection {...(ctx.onSignOut !== undefined ? { onSignOut: ctx.onSignOut } : {})} />
        ),
      },
    ],
  },
  {
    id: "everyone",
    label: SETTINGS_STRINGS.groupEveryoneLabel,
    sections: [
      {
        // Leads Shared Settings: a key added here is what everyone
        // creating workbenches in this tenancy inherits.
        id: "credentials",
        title: SETTINGS_STRINGS.credentialsSectionTitle,
        icon: Key,
        gate: "credentials",
        render: (ctx) => <CredentialsSection tenantId={ctx.tenantId} />,
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
        // No gate — model:*/provider:* read is the same grant every
        // member needs to chat at all.
        id: "models",
        title: SETTINGS_STRINGS.modelsSectionTitle,
        icon: Cpu,
        render: (ctx) => <ModelsSection tenantId={ctx.tenantId} />,
      },
      {
        id: "audit",
        title: SETTINGS_STRINGS.auditSectionTitle,
        icon: ListBullets,
        advanced: true,
        render: () => <AuditSection />,
      },
    ],
  },
];

// A section is dropped entirely, never rendered disabled, until its gate
// probe resolves `allowed`. A probe `error` withholds too but marks the
// group `accessProbeFailed` so a host can show a couldn't-check state.
export function resolveSettingsSectionGroups(
  access: TenancyAccess,
): readonly SettingsSectionGroup[] {
  return SETTINGS_SECTION_GROUPS.map((group) => {
    const accessProbeFailed = group.sections.some(
      (section) => section.gate !== undefined && access[section.gate] === "error",
    );
    return {
      id: group.id,
      label: group.label,
      sections: group.sections
        .filter((section) => section.gate === undefined || access[section.gate] === "allowed")
        .map(({ gate: _gate, ...section }) => section),
      ...(accessProbeFailed ? { accessProbeFailed: true as const } : {}),
    };
  });
}

// A host calling this must pass the same `extra` list to every consumer
// (settings stage and its own section nav), or the two surfaces drift.
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
