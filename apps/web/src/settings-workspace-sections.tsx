// This app's own additions to the Workspace settings group: Agents and
// Skills (CL-5990). `@corbits/settings-ui` stays generic — it owns the
// Personal/Workspace shell and gating, never a specific app's domain
// sections — so these two are assembled here and spliced in via the
// package's `insertWorkspaceSections`, the same seam `settings-page.tsx`
// and `pages/settings-nav.tsx` both call so the stage and its section nav
// can never drift on what Workspace contains.

import type { SettingsSection } from "@corbits/settings-ui";
import { Bot, Sparkles } from "lucide-react";

import { AgentsSettingsSection } from "./pages/agents-settings-section";
import { SkillsSettingsSection } from "./pages/skills-settings-section";

export const AGENTS_SECTION_ID = "agents";
export const SKILLS_SECTION_ID = "skills";

export function workspaceExtraSections(): readonly SettingsSection[] {
  return [
    {
      id: AGENTS_SECTION_ID,
      title: "Agents",
      icon: Bot,
      render: (ctx) => (
        <AgentsSettingsSection
          tenantId={ctx.tenantId}
          {...(ctx.navigate !== undefined ? { navigate: ctx.navigate } : {})}
          entityId={ctx.entityId ?? null}
        />
      ),
    },
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
  ];
}
