// Thin mount of `@corbits/settings-ui`'s shell: this file only supplies the
// literal section registry and adapts the app's bench-selection state (see
// ../bench-context.tsx) into the shape the package expects. Every section's
// data-fetching, form state, and save logic lives in the package.

import {
  AccountSection,
  BenchSection,
  ChatSection,
  SettingsShell,
} from "@corbits/settings-ui";
import type { SettingsContext, SettingsSection } from "@corbits/settings-ui";
import { PageShell, TopBar, TopBarTitle } from "@corbits/react-ui";

import { useBench } from "../bench-context";

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "bench",
    title: "Bench",
    render: (ctx: SettingsContext) => <BenchSection tenantId={ctx.tenantId} />,
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

export function SettingsRoute() {
  const { selectedTenantId } = useBench();

  return (
    <>
      <TopBar>
        <TopBarTitle subtitle="Your bench, its chats and channels, and your account">
          Settings
        </TopBarTitle>
      </TopBar>
      <PageShell width="full" className="page-fill">
        <SettingsShell
          sections={SETTINGS_SECTIONS}
          context={{ tenantId: selectedTenantId }}
        />
      </PageShell>
    </>
  );
}
