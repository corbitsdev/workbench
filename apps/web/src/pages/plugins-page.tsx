// The Plugins gallery route (CL-6090) — a thin composition, same shape as
// `library-page.tsx`: page-level data fetching and wiring live here,
// presentation lives in `@corbits/plugins-ui`. This page reads the
// currently selected bench tenant the same way every other Settings
// surface does (`useBench().selectedTenantId`) — the owner's "PARENT
// (account/root) tenant" framing maps onto whichever tenant that is: the
// app has no separate "account" tenant type above a bench today, and this
// page's own data is always that tenant's OWN plugin connections plus
// whatever it inherits from its ancestors, exactly like every other
// Connections surface. See this ticket's report for the full grounding.
//
// Skills gets the same gallery treatment as plugins (owner ruling): cards,
// not the Settings section's list rows — reusing `../skills-api.ts`'s data
// and mutations through `PluginSkillDetailPanel`, never forking
// `SkillsSettingsSection` itself.

import { Button, PageShell, RichEmptyState } from "@corbits/react-ui";
import { PluginsGallery, PluginConnectPanel } from "@corbits/plugins-ui";
import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { listPluginsForTenant } from "@workbench/connections/plugins";
import { Blocks, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useBench } from "../bench-context";
import { StageTopBar } from "../shell/stage-top-bar";
import { createSkill, listSkills, type SkillSummary } from "../skills-api";
import { CreateSkillDialog, type SkillCreateInput } from "./create-skill-dialog";
import { PluginSkillDetailPanel } from "./plugin-skill-detail-panel";

type PluginsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly plugins: readonly ResolvedPlugin[] }
  | { readonly status: "error"; readonly message: string };

type SkillsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly skills: readonly SkillSummary[] }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function PluginsRoute({
  path: _path,
}: {
  readonly path: string;
  readonly navigate?: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const [pluginsState, setPluginsState] = useState<PluginsState>({
    status: "loading",
  });
  const [skillsState, setSkillsState] = useState<SkillsState>({
    status: "loading",
  });
  const [openPlugin, setOpenPlugin] = useState<ResolvedPlugin | null>(null);
  const [openSkillName, setOpenSkillName] = useState<string | null>(null);
  const [createSkillOpen, setCreateSkillOpen] = useState(false);

  const reloadPlugins = useCallback(() => {
    if (selectedTenantId === null) return;
    listPluginsForTenant(selectedTenantId)
      .then((plugins) => setPluginsState({ status: "ready", plugins }))
      .catch((cause: unknown) =>
        setPluginsState({ status: "error", message: messageOf(cause) }),
      );
  }, [selectedTenantId]);

  const reloadSkills = useCallback(() => {
    if (selectedTenantId === null) return;
    listSkills(selectedTenantId)
      .then((skills) => setSkillsState({ status: "ready", skills }))
      .catch((cause: unknown) =>
        setSkillsState({ status: "error", message: messageOf(cause) }),
      );
  }, [selectedTenantId]);

  useEffect(() => {
    setPluginsState({ status: "loading" });
    reloadPlugins();
  }, [reloadPlugins]);

  useEffect(() => {
    setSkillsState({ status: "loading" });
    reloadSkills();
  }, [reloadSkills]);

  async function handleCreateSkill(input: SkillCreateInput) {
    if (selectedTenantId === null) return;
    const skill = await createSkill(selectedTenantId, input);
    setCreateSkillOpen(false);
    reloadSkills();
    setOpenSkillName(skill.name);
  }

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Plugins" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Blocks />}
            title="Select a workbench"
            description="Pick a workbench from the switcher to see its plugins."
          />
        </PageShell>
      </div>
    );
  }

  const tenantId = selectedTenantId;

  if (pluginsState.status === "error" || skillsState.status === "error") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Plugins" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Blocks />}
            title="Couldn't load the plugins gallery"
            description={
              pluginsState.status === "error"
                ? pluginsState.message
                : skillsState.status === "error"
                  ? skillsState.message
                  : ""
            }
          />
        </PageShell>
      </div>
    );
  }

  if (pluginsState.status === "loading" || skillsState.status === "loading") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Plugins" />
        <PageShell width="full" className="page-fill" />
      </div>
    );
  }

  const skillCards = skillsState.skills.map((skill) => ({
    assetId: skill.assetId,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title="Plugins"
        subtitle={`${pluginsState.plugins.length} plugins · ${skillsState.skills.length} skills`}
        actions={
          <Button size="sm" onClick={() => setCreateSkillOpen(true)}>
            <Plus /> New skill
          </Button>
        }
      />
      <PageShell width="full" className="page-fill">
        <PluginsGallery
          plugins={pluginsState.plugins}
          skills={skillCards}
          onOpenPlugin={setOpenPlugin}
          onOpenSkill={(skill) => setOpenSkillName(skill.name)}
        />
      </PageShell>
      <PluginConnectPanel
        tenantId={tenantId}
        plugin={openPlugin}
        onClose={() => setOpenPlugin(null)}
        onChanged={reloadPlugins}
      />
      <PluginSkillDetailPanel
        tenantId={tenantId}
        skillName={openSkillName}
        onClose={() => setOpenSkillName(null)}
        onChanged={reloadSkills}
      />
      <CreateSkillDialog
        open={createSkillOpen}
        onOpenChange={setCreateSkillOpen}
        onCreate={handleCreateSkill}
      />
    </div>
  );
}
