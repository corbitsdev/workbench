// Skills: a standalone rail destination (CL-6355), over the workbench's
// real skill registry (`@corbits/skills`, via `../skills-api.ts`). Used to
// be a Settings section (CL-5990); the owner moved it back out to its own
// page — this is the only surface left, there is no Settings duplicate.
// This replaced the session-local store CL-5991 shipped before that: a
// skill now lives in a native `kind:"skill"` hub asset the moment it is
// created, and its version history is that asset's git history.
//
// Two states a skill can be in, both visible in the "Who can see it"
// column:
//   private  — visible only to the person who wrote it (the default)
//   shared   — visible to the whole workbench
//
// There is no external catalog: skills are authored in this workbench.
// This page lists them; a single skill — its editor, its versions, its
// visibility toggle — lives on its own page (`skill-detail-page.tsx`).

import {
  PageShell,
  Badge,
  Button,
  EmptyState,
  LibrarySearchInput,
  RichEmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import { Lightning, Plus } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { rowActivationProps } from "../activatable-row";
import { consumePendingNewSkill } from "../command-palette-actions";
import {
  createSkill,
  createSkillFromFile,
  listSkills,
  type SkillSummary,
} from "../skills-api";
import {
  CreateSkillDialog,
  type SkillCreateInput,
} from "./create-skill-dialog";
import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX } from "../path-ids";
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

/**
 * The Skills roster over one workbench's skill registry, with its own
 * top-nav contract (CL-6409): the trail says where the reader is and the
 * top bar's action slot is the only home for "New skill". `tenantId` is the
 * registry every read is scoped to; opening a row navigates to that skill's
 * own page at `/skills/<name>` (CL-6416), which is where editing, versions,
 * and diffs live — this page never renders a skill inline.
 */
export function SkillsPage({
  tenantId,
  navigate,
}: {
  readonly tenantId: string | null;
  readonly navigate?: (to: string) => void;
}) {
  const [state, setState] = useState<RegistryState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    if (tenantId === null) return;
    setState({ status: "loading" });
    try {
      const skills = await listSkills(tenantId);
      setState({ status: "ready", skills });
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (consumePendingNewSkill()) setCreateOpen(true);
  }, []);

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  function open(name: string) {
    navigate?.(`${SKILLS_PATH_PREFIX}/${encodeURIComponent(name)}`);
  }

  async function handleCreate(input: SkillCreateInput) {
    if (tenantId === null) return;
    const skill =
      input.kind === "file"
        ? await createSkillFromFile(tenantId, input.source)
        : await createSkill(tenantId, {
            name: input.name,
            description: input.description,
            body: input.body,
          });
    setCreateOpen(false);
    await reload();
    open(skill.name);
  }

  const createDialog = (
    <CreateSkillDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onSubmit={handleCreate}
    />
  );

  const crumbs = [{ label: "Skills" }];

  function stage(actions: ReactNode, body: ReactNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={crumbs} actions={actions} />
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
      <p className="text-sm text-muted-foreground">
        Pick a workbench to see its skills.
      </p>,
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
    <>
      <LibrarySearchInput
        label="Search skills"
        value={query}
        onChange={setQuery}
      />
      {newSkillButton}
    </>,
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
                <TableHead className="w-36">Who can see it</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((skill) => (
                <TableRow
                  key={skill.assetId}
                  className="cursor-pointer"
                  {...rowActivationProps(() => open(skill.name))}
                >
                  <TableCell className="w-48 font-medium">
                    {skill.name}
                  </TableCell>
                  <TableCell className="max-w-sm truncate text-muted-foreground">
                    {skill.description}
                  </TableCell>
                  <TableCell className="w-36">
                    <Badge tone={skill.scope === "tenant" ? "info" : "neutral"}>
                      {skill.scope === "tenant" ? "Everyone" : "Only me"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {createDialog}
    </div>,
  );
}

/**
 * Skills roster mount at `/skills` (CL-6355): a thin adapter that resolves
 * which workbench's registry is listed. The stage chrome (breadcrumb trail,
 * action slot) belongs to `SkillsPage`; a single skill has its own route
 * (`/skills/<name>`, `skill-detail-page.tsx`).
 */
export function SkillsRoute({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();

  return <SkillsPage tenantId={selectedTenantId} navigate={navigate} />;
}
