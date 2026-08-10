// Thin mount of `@corbits/settings-ui`'s shell: this file only supplies the
// literal section registry and adapts the app's bench-selection state (see
// ../bench-context.tsx) into the shape the package expects. Every section's
// data-fetching, form state, and save logic lives in the package. People,
// Roles, and Grants are gated by `useTenancyAccess` — a section stays out
// of the registry entirely until its permission probe resolves `allowed`,
// never rendered and disabled.

import {
  AccountSection,
  BenchSection,
  ChatSection,
  CredentialsSection,
  GrantsSection,
  PeopleSection,
  RolesSection,
  SettingsShell,
  useTenancyAccess,
} from "@corbits/settings-ui";
import type { SettingsContext, SettingsSection } from "@corbits/settings-ui";
import { PageShell } from "@corbits/react-ui";

import { useBench } from "../bench-context";

export function SettingsRoute() {
  const { selectedTenantId, selectedPrincipalId } = useBench();
  const access = useTenancyAccess(selectedTenantId, selectedPrincipalId);

  const sections: SettingsSection[] = [
    {
      id: "bench",
      title: "Bench",
      render: (ctx: SettingsContext) => (
        <BenchSection tenantId={ctx.tenantId} />
      ),
    },
    {
      id: "chat",
      title: "Chats & channels",
      render: (ctx: SettingsContext) => <ChatSection tenantId={ctx.tenantId} />,
    },
    {
      id: "account",
      title: "Account",
      render: () => <AccountSection />,
    },
  ];

  if (access.people === "allowed") {
    sections.push({
      id: "people",
      title: "People",
      render: (ctx: SettingsContext) => (
        <PeopleSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.roles === "allowed") {
    sections.push({
      id: "roles",
      title: "Roles",
      render: (ctx: SettingsContext) => (
        <RolesSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.grants === "allowed") {
    sections.push({
      id: "grants",
      title: "Grants",
      render: (ctx: SettingsContext) => (
        <GrantsSection tenantId={ctx.tenantId} />
      ),
    });
  }
  if (access.credentials === "allowed") {
    sections.push({
      id: "credentials",
      title: "Credentials",
      render: (ctx: SettingsContext) => (
        <CredentialsSection tenantId={ctx.tenantId} />
      ),
    });
  }

  return (
    <PageShell width="full" className="page-fill">
      <SettingsShell
        sections={sections}
        context={{
          tenantId: selectedTenantId,
          principalId: selectedPrincipalId,
        }}
      />
    </PageShell>
  );
}
