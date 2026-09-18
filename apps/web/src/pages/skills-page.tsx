// A skill lives in a native `kind:"skill"` hub asset the moment it's
// created; its version history is that asset's git history.
//
// Two states visible in "Who can see it": private (default) or shared
// with the whole workbench. No external catalog — skills are authored here.

import {
  PageShell,
  Button,
  EmptyState,
  RichEmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { Lightning, Plus } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { tenantKeys } from "../query-client";

import { rowActivationProps } from "../activatable-row";
import { consumePendingNewSkill } from "../command-palette-actions";
import { createSkill, listSkills, type SkillSummary } from "../skills-api";
import { CreateSkillDialog, type SkillCreateInput } from "./create-skill-dialog";
import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX } from "../path-ids";
import { skillDisplayName } from "../skill-display-name";
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

  const crumbs = [{ label: "Skills" }];

  function stage(
    actions: ReactNode,
    body: ReactNode,
    filter?: {
      readonly value: string;
      readonly onChange: (value: string) => void;
    },
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={crumbs}
          {...(filter === undefined ? {} : { filter: { label: "Filter skills", ...filter } })}
          actions={actions}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageShell width="full" className="page-fill">
            {body}
          </PageShell>
        </div>
      </div>
    );
  }

  const newSkillButton = (
    <Button size="sm" onClick={() => setCreateOpen(true)}>
      <Plus /> New skill
    </Button>
  );

  if (tenantId === null) {
    return stage(
      null,
      <p className="text-sm text-muted-foreground">Pick a workbench to see its skills.</p>,
    );
  }

  if (state.status === "loading") {
    return stage(null, <WorkbenchLoadingState title="Loading skills…" />);
  }

  if (state.status === "error") {
    return stage(
      null,
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
      newSkillButton,
      <div className="flex flex-col gap-4">
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
    newSkillButton,
    <div className="flex flex-col gap-4">
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Lightning />}
          title="No matching skills"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <div className="px-4 pb-5 sm:px-7">
          <Table aria-label="Skills">
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">Name</TableHead>
                <TableHead className="max-w-sm">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((skill) => (
                <TableRow
                  key={skill.assetId}
                  className="cursor-pointer"
                  {...rowActivationProps(() => open(skill.name))}
                >
                  <TableCell className="w-48 font-medium">{skillDisplayName(skill)}</TableCell>
                  <TableCell className="max-w-sm truncate text-muted-foreground">
                    {skill.description}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {createDialog}
    </div>,
    { value: query, onChange: setQuery },
  );
}

// A thin adapter that resolves which workbench's registry is listed.
export function SkillsRoute({ navigate }: { readonly navigate: (to: string) => void }) {
  const { selectedTenantId } = useBench();

  return <SkillsPage tenantId={selectedTenantId} navigate={navigate} />;
}
