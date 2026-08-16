// This app's own additions to the Everyone settings group: Skills (CL-5990)
// and Config Profiles. `@corbits/settings-ui` stays generic — it owns the
// Account/Everyone shell and gating, never a specific app's domain
// sections — so these are assembled here and spliced in via the package's
// `insertEveryoneSections`, the same seam `settings-page.tsx` and
// `pages/settings-nav.tsx` both call so the stage and its section nav can
// never drift on what Everyone contains. Agents (CL-5990) was cut in
// CL-6121 — a directory tab in global Settings duplicated agent
// configuration that already lives per-workbench (`@corbits/chat-ui`'s
// `ChannelSettingsSurface`, "Assistant" section, CL-6084); that's the one
// place it belongs now.

import type { SettingsSection } from "@corbits/settings-ui";
import { ProfilesSettingsSection } from "@corbits/config-profiles-ui";
import { SlidersHorizontal, Sparkles } from "lucide-react";

import { SkillsSettingsSection } from "./pages/skills-settings-section";

export const SKILLS_SECTION_ID = "skills";
export const CONFIG_PROFILES_SECTION_ID = "config-profiles";

export function everyoneExtraSections(): readonly SettingsSection[] {
  return [
    {
      id: SKILLS_SECTION_ID,
      title: "Skills",
      icon: Sparkles,
      render: (ctx) => (
        <SkillsSettingsSection
          tenantId={ctx.tenantId}
          {...(ctx.navigate !== undefined ? { navigate: ctx.navigate } : {})}
          entityId={ctx.entityId ?? null}
        />
      ),
    },
    {
      id: CONFIG_PROFILES_SECTION_ID,
      title: "Profiles",
      icon: SlidersHorizontal,
      render: (ctx) => <ProfilesSettingsSection tenantId={ctx.tenantId} />,
    },
  ];
}
