// A skill lives in a native `kind:"skill"` hub asset the moment it's
// created; its version history is that asset's git history. No external
// catalog — skills are authored here, private by default or shared.

import { EmptyState, RichEmptyState } from "@corbits/react-ui";
import { Lightning } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { tenantKeys } from "../query-client";

import { rowActivationProps } from "../activatable-row";
import { ListCard, ListFilter } from "./library-list";
import { RoutinePill } from "./routine-ui";
import { consumePendingNewSkill } from "../command-palette-actions";
import { createSkill, listSkills, type SkillSummary } from "../skills-api";
import { CreateSkillDialog, type SkillCreateInput } from "./create-skill-dialog";
import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX } from "../path-ids";
import { skillDisplayName } from "../skill-display-name";
import { useFromBench } from "../shell/page-crumbs";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";

type RegistryState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly skills: readonly SkillSummary[];
    }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Opening a row navigates to `/skills/<name>`: editing, versions, and
// diffs live there, never rendered inline here.
export function SkillsPage({
  tenantId,
  navigate,
}: {
  readonly tenantId: string | null;
  readonly navigate?: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  // The "New skill" hop from elsewhere is consumed once, as the page mounts.
  const [createOpen, setCreateOpen] = useState(() => consumePendingNewSkill());

  const registry = useQuery({
    queryKey: tenantKeys.skills(tenantId ?? "none"),
    queryFn: () => (tenantId === null ? Promise.resolve([]) : listSkills(tenantId)),
    enabled: tenantId !== null,
  });
  const state: RegistryState = registry.isError
    ? { status: "error", message: messageOf(registry.error) }
    : registry.data === undefined
      ? { status: "loading" }
      : { status: "ready", skills: registry.data };

  const reload = useCallback(async () => {
    if (tenantId === null) return;
    await queryClient.invalidateQueries({ queryKey: tenantKeys.skills(tenantId) });
  }, [queryClient, tenantId]);

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () => window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  function open(name: string) {
    navigate?.(`${SKILLS_PATH_PREFIX}/${encodeURIComponent(name)}`);
  }

  async function handleCreate(input: SkillCreateInput) {
    if (tenantId === null) return;
    const skill = await createSkill(tenantId, {
      name: input.name,
      ...(input.displayName !== "" ? { displayName: input.displayName } : {}),
    });
    setCreateOpen(false);
    await reload();
    open(skill.name);
  }

  const createDialog = (
    <CreateSkillDialog open={createOpen} onOpenChange={setCreateOpen} onSubmit={handleCreate} />
  );

  function stage(body: ReactNode) {
    return (
      <div className="page-frame">
        <StageTopBar title="Skills" />
        <div className="page-scroll">
          <PageLayout
            title="Skills"
            subtitle="Know-how your workers draw on. Ask for more in any bench."
          >
            {body}
          </PageLayout>
        </div>
      </div>
    );
  }

  const filterInput = <ListFilter label="Filter skills" value={query} onChange={setQuery} />;

  if (tenantId === null) {
    return stage(<p className="page-note">Pick a workbench to see its skills.</p>);
  }

  if (state.status === "loading") {
    return stage(<WorkbenchLoadingState title="Loading skills…" />);
  }

  if (state.status === "error") {
    return stage(
      <RichEmptyState
        icon={<Lightning />}
        title="Couldn't load your skills"
        description="Something went wrong on our side. Try again in a moment."
        actions={[{ label: "Retry", onClick: () => void reload() }]}
      />,
    );
  }

  const { skills } = state;

  if (skills.length === 0) {
    return stage(
      <div className="page-stack">
        {filterInput}
        <RichEmptyState
          icon={<Lightning />}
          title="No skills yet"
          description="A skill is a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent can pin. Write one in this workbench and publish it into the registry."
        />
        {createDialog}
      </div>,
    );
  }

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? skills
      : skills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(needle) ||
            skill.description.toLowerCase().includes(needle),
        );

  return stage(
    <>
      {filterInput}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Lightning />}
          title="No matching skills"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <ListCard
          label="Skills"
          columns="minmax(0, 1fr) minmax(0, 2fr) 96px"
          heads={["Skill", "What it teaches", "Status"]}
        >
          {filtered.map((skill) => (
            <li
              key={skill.assetId}
              className="lib-row"
              data-link
              {...rowActivationProps(() => open(skill.name))}
            >
              <span className="lib-cell lib-name lib-name--mono">{skillDisplayName(skill)}</span>
              <span className="lib-cell lib-cell--soft">{skill.description}</span>
              <span className="lib-cell">
                <RoutinePill tone="live">installed</RoutinePill>
              </span>
            </li>
          ))}
        </ListCard>
      )}
      {createDialog}
    </>,
  );
}

// A thin adapter that resolves which workbench's registry is listed.
export function SkillsRoute({ navigate }: { readonly navigate: (to: string) => void }) {
  const { selectedTenantId } = useBench();
  const fromBench = useFromBench();

  return <SkillsPage tenantId={fromBench ?? selectedTenantId} navigate={navigate} />;
}
