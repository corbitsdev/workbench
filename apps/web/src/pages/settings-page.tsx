// Thin mount of `@corbits/settings-ui`'s shell: this file only supplies the
// literal Personal / Workspace section groups and adapts the app's
// bench-selection state (see ../bench-context.tsx) into the shape the package
// expects. Every section's data-fetching, form state, and save logic lives in
// the package. People, Roles, Grants, and Credentials are gated by
// `useTenancyAccess` — a section stays out of the registry entirely until its
// permission probe resolves `allowed`, never rendered and disabled.

import {
  AccountSection,
  AgentSection,
  AuditSection,
  BenchSection,
  ChatSection,
  CredentialsSection,
  GrantsSection,
  NotificationsSection,
  PeopleSection,
  RolesSection,
  SettingsShell,
  SETTINGS_STRINGS,
  useTenancyAccess,
} from "@corbits/settings-ui";
import type {
  SettingsContext,
  SettingsSection,
  SettingsSectionGroup,
} from "@corbits/settings-ui";
import { PageShell } from "@corbits/react-ui";

import { useBench } from "../bench-context";

export function SettingsRoute() {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const access = useTenancyAccess(selectedTenantId, selectedPrincipalId);

  const personal: SettingsSection[] = [
    {
      id: "agent",
      title: SETTINGS_STRINGS.agentSectionTitle,
      render: () => <AgentSection />,
    },
    {
      id: "notifications",
      title: SETTINGS_STRINGS.notificationsSectionTitle,
      render: () => <NotificationsSection />,
    },
    {
      id: "account",
      title: SETTINGS_STRINGS.accountSectionTitle,
      render: () => <AccountSection />,
    },
  ];

  const workspace: SettingsSection[] = [
    {
      id: "bench",
      title: SETTINGS_STRINGS.benchSectionTitle,
      render: (ctx: SettingsContext) => (
        <>
          <BenchSection tenantId={ctx.tenantId} />
          <ChatSection tenantId={ctx.tenantId} />
        </>
      ),
    },
  ];

  if (access.people === "allowed") {
    workspace.push({
      id: "people",
      title: SETTINGS_STRINGS.peopleSectionTitle,
      render: (ctx: SettingsContext) => (
        <PeopleSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.roles === "allowed") {
    workspace.push({
      id: "roles",
      title: SETTINGS_STRINGS.rolesSectionTitle,
      render: (ctx: SettingsContext) => (
        <RolesSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.grants === "allowed") {
    workspace.push({
      id: "grants",
      title: SETTINGS_STRINGS.grantsSectionTitle,
      render: (ctx: SettingsContext) => (
        <GrantsSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.credentials === "allowed") {
    workspace.push({
      id: "credentials",
      title: SETTINGS_STRINGS.credentialsSectionTitle,
      render: (ctx: SettingsContext) => (
        <CredentialsSection tenantId={ctx.tenantId} />
      ),
    });
  }

  workspace.push({
    id: "audit",
    title: SETTINGS_STRINGS.auditSectionTitle,
    render: () => <AuditSection />,
  });

  const groups: SettingsSectionGroup[] = [
    {
      id: "personal",
      label: SETTINGS_STRINGS.groupPersonalLabel,
      sections: personal,
    },
    {
      id: "workspace",
      label: SETTINGS_STRINGS.groupWorkspaceLabel,
      sections: workspace,
    },
  ];

  return (
    <PageShell width="full" className="page-fill">
      <SettingsShell
        groups={groups}
        context={{
          tenantId: selectedTenantId,
          principalId: selectedPrincipalId,
        }}
      />
    </PageShell>
  );
}
