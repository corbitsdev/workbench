// Skills: a standalone rail destination (CL-6355), over the workbench's
// real skill registry (`@corbits/skills`, via `../skills-api.ts`). Used to
// be a Settings section (CL-5990); the owner moved it back out to its own
// page — this is the only surface left, there is no Settings duplicate.
// This replaced the session-local store CL-5991 shipped before that: a
// skill now lives in a native `kind:"skill"` hub asset the moment it is
// created, and its version history is that asset's git history.
//
// Two states a skill can be in, both visible here:
//   private  — visible only to the person who wrote it (the default)
//   shared   — visible to the whole workbench
//
// There is no external catalog: skills are authored in this workbench.
// "Share with workbench" and "Make private" are the two directions of
// that visibility toggle, not an install step.

import {
  PageShell,
  Badge,
  Button,
  EmptyState,
  LibrarySearchInput,
  RichEmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
} from "@corbits/react-ui";
import { Lightning, PencilSimple, Plus } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { rowActivationProps } from "../activatable-row";
import { consumePendingNewSkill } from "../command-palette-actions";
import {
  createSkill,
  listSkills,
  listSkillVersions,
  loadSkill,
  restoreSkillVersion,
  setSkillScope,
  updateSkill,
  type PinnedByEntry,
  type SkillDetail,
  type SkillSummary,
  type SkillVersion,
} from "../skills-api";
import {
  CreateSkillDialog,
  type SkillCreateInput,
} from "./create-skill-dialog";
import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX, skillIdFromPath } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";

type RegistryState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly skills: readonly SkillSummary[];
    }
  | { readonly status: "error"; readonly message: string };

type DetailState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly skill: SkillDetail;
      readonly pinnedBy: readonly PinnedByEntry[];
      readonly versions: readonly SkillVersion[];
    }
  | { readonly status: "error"; readonly message: string };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SkillDetailView({
  tenantId,
  name,
  now,
  onChanged,
}: {
  readonly tenantId: string;
  readonly name: string;
  readonly now: number;
  readonly onChanged: () => void;
}) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const reload = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const [detail, versions] = await Promise.all([
        loadSkill(tenantId, name),
        listSkillVersions(tenantId, name),
      ]);
      setState({
        status: "ready",
        skill: detail.skill,
        pinnedBy: detail.pinnedBy,
        versions,
      });
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    }
  }, [tenantId, name]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.status === "loading") {
    return <WorkbenchLoadingState title="Loading skill…" />;
  }
  if (state.status === "error") {
    return (
      <RichEmptyState
        icon={<Lightning />}
        title="Couldn't load this skill"
        description="Something went wrong on our side. Try again in a moment."
        actions={[{ label: "Retry", onClick: () => void reload() }]}
      />
    );
  }

  const { skill, pinnedBy, versions } = state;
  const shared = skill.scope === "tenant";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await reload();
      onChanged();
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {skill.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {skill.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={shared ? "info" : "neutral"}>
            {shared ? "Shared" : "Private"}
          </Badge>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditOpen(true)}
          >
            <PencilSimple /> Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(() =>
                setSkillScope(
                  tenantId,
                  skill.name,
                  shared ? "private" : "tenant",
                ),
              )
            }
          >
            {shared ? "Make private" : "Share with workbench"}
          </Button>
        </div>
      </header>

      <CreateSkillDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode="edit"
        initialValues={{
          name: skill.name,
          description: skill.description,
          body: skill.body,
        }}
        onSubmit={async (input) => {
          await updateSkill(tenantId, skill.name, {
            description: input.description,
            body: input.body,
          });
          setEditOpen(false);
          await reload();
          onChanged();
        }}
      />

      <Section title="About" description="What this skill packages.">
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
          {skill.body}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Updated {formatRelativeTime(skill.updatedAtIso, now)}
        </p>
      </Section>

      <Section
        title="Pinned by"
        description="Agents that currently declare this skill."
      >
        {pinnedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents pin this skill yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {pinnedBy.map((entry) => (
              <li key={entry.definitionId}>
                <Badge tone="neutral">{entry.name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Version history"
        description="Every saved version of this skill. Restore makes an older version the current one."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Version</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version, index) => (
              <TableRow key={version.commitSha}>
                <TableCell className="text-sm" title={version.commitSha}>
                  {`Version ${versions.length - index}`}
                  {version.current ? (
                    <Badge tone="success" className="ml-2">
                      current
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm">{version.message}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {version.author}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelativeTime(version.committedAtIso, now)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={version.current || busy}
                    onClick={() =>
                      void run(() =>
                        restoreSkillVersion(
                          tenantId,
                          skill.name,
                          version.commitSha,
                        ),
                      )
                    }
                  >
                    Restore
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </div>
  );
}

/**
 * The Skills stage: master-detail over one workbench's skill registry, with
 * its own top-nav contract (CL-6409) — the trail says where the reader is
 * (`Skills / <skill>`, the parent crumb deep-linking back to `/skills`) and
 * the top bar's action slot is the only home for "New skill". `tenantId` is
 * the registry every read and write is scoped to; `navigate`/`entityId`
 * drive the `/skills/:name` deep link when passed (see `SkillsRoute`
 * below), or stay local to the component otherwise — same
 * optional-controlled-selection contract `AgentsSection` uses.
 */
export function SkillsPage({
  tenantId,
  navigate,
  entityId,
  now = Date.now(),
}: {
  readonly tenantId: string | null;
  readonly navigate?: (to: string) => void;
  readonly entityId?: string | null;
  readonly now?: number;
}) {
  const [state, setState] = useState<RegistryState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(entityId ?? null);
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

  // The route is the source of truth for which skill is open: the same
  // component instance stays mounted across `/skills/<name>` → `/skills`
  // (both match the one route entry), so a crumb click that only changes
  // the URL has to move the view with it.
  useEffect(() => {
    setSelected(entityId ?? null);
  }, [entityId]);

  useEffect(() => {
    if (consumePendingNewSkill()) setCreateOpen(true);
  }, []);

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  function select(name: string | null) {
    setSelected(name);
    navigate?.(
      name === null
        ? SKILLS_PATH_PREFIX
        : `${SKILLS_PATH_PREFIX}/${encodeURIComponent(name)}`,
    );
  }

  async function handleCreate(input: SkillCreateInput) {
    if (tenantId === null) return;
    const skill = await createSkill(tenantId, input);
    setCreateOpen(false);
    await reload();
    select(skill.name);
  }

  const createDialog = (
    <CreateSkillDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onSubmit={handleCreate}
    />
  );

  const crumbs =
    selected === null
      ? [{ label: "Skills" }]
      : [{ label: "Skills", href: SKILLS_PATH_PREFIX }, { label: selected }];

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

  if (selected !== null) {
    return stage(
      newSkillButton,
      <div className="flex flex-col gap-4">
        <SkillDetailView
          tenantId={tenantId}
          name={selected}
          now={now}
          onChanged={() => void reload()}
        />
        {createDialog}
      </div>,
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
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Access</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((skill) => (
                <TableRow
                  key={skill.assetId}
                  className="cursor-pointer"
                  {...rowActivationProps(() => select(skill.name))}
                >
                  <TableCell className="font-medium">{skill.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {skill.description}
                  </TableCell>
                  <TableCell>
                    <Badge tone={skill.scope === "tenant" ? "info" : "neutral"}>
                      {skill.scope === "tenant" ? "Shared" : "Private"}
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
 * Skills stage mount at `/skills` (CL-6355): a thin adapter that resolves
 * the bench tenant and the `/skills/:name` deep link. The stage chrome
 * itself (breadcrumb trail, action slot) belongs to `SkillsPage`, which is
 * the component that knows which skill is open.
 */
export function SkillsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const entityId = skillIdFromPath(path);

  return (
    <SkillsPage
      tenantId={selectedTenantId}
      navigate={navigate}
      entityId={entityId}
    />
  );
}
