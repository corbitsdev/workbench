// Settings · Skills, over the workbench's real skill registry
// (`@corbits/skills`, via `../skills-api.ts`). This replaced the
// session-local store CL-5991 shipped: a skill now lives in a native
// `kind:"skill"` hub asset, its version history is that asset's git
// history, and a draft is a pending row on the same registry rather than
// something that vanishes with the browser tab.
//
// Three states a skill can be in, all visible here:
//   pending  — a draft exists; publishing turns it into a real skill
//   private  — published, visible only to the person who wrote it
//   shared   — published and installed for the whole workbench
//
// "Install" and "Uninstall" are the two directions of that last step.

import {
  Badge,
  Button,
  EmptyState,
  Input,
  RichEmptyState,
  Section,
  SidebarItemRow,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
} from "@corbits/react-ui";
import { Plus, Search, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { consumePendingNewSkill } from "../command-palette-actions";
import {
  createSkillDraft,
  listSkillDrafts,
  listSkills,
  listSkillVersions,
  loadSkill,
  publishSkillDraft,
  restoreSkillVersion,
  setSkillScope,
  type PinnedByEntry,
  type SkillDetail,
  type SkillDraft,
  type SkillSummary,
  type SkillVersion,
} from "../skills-api";
import { CreateSkillDialog, type SkillDraftInput } from "./create-skill-dialog";

type RegistryState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly skills: readonly SkillSummary[];
      readonly drafts: readonly SkillDraft[];
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
    return <p className="text-sm text-muted-foreground">Loading skill…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="text-sm text-danger-foreground" role="alert">
        Could not load “{name}”: {state.message}
      </p>
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
            {shared ? "Installed" : "Private"}
          </Badge>
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
            {shared ? "Uninstall" : "Install"}
          </Button>
        </div>
      </header>

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
        description="Every commit on this skill's asset. Restore re-commits an older version as the current one."
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
            {versions.map((version) => (
              <TableRow key={version.commitSha}>
                <TableCell className="font-mono text-xs">
                  {version.commitSha.slice(0, 8)}
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
 * Settings · Skills. `navigate` and `entityId` come from the settings
 * section context (see `../settings-workspace-sections.tsx`); `tenantId`
 * is the registry every read and write is scoped to.
 */
export function SkillsSettingsSection({
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
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (tenantId === null) return;
    setState({ status: "loading" });
    try {
      const [skills, drafts] = await Promise.all([
        listSkills(tenantId),
        listSkillDrafts(tenantId),
      ]);
      setState({ status: "ready", skills, drafts });
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

  function select(name: string | null) {
    setSelected(name);
    navigate?.(
      name === null
        ? "/settings/skills"
        : `/settings/skills/${encodeURIComponent(name)}`,
    );
  }

  async function handleDrafted(draft: SkillDraftInput) {
    if (tenantId === null) return;
    setActionError(null);
    try {
      await createSkillDraft(tenantId, draft);
      setCreateOpen(false);
      await reload();
    } catch (cause) {
      setActionError(messageOf(cause));
    }
  }

  async function handlePublish(name: string) {
    if (tenantId === null) return;
    setActionError(null);
    try {
      await publishSkillDraft(tenantId, name, "private");
      await reload();
      select(name);
    } catch (cause) {
      setActionError(messageOf(cause));
    }
  }

  const createDialog = (
    <CreateSkillDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onDrafted={(draft) => void handleDrafted(draft)}
    />
  );

  if (tenantId === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Pick a workbench to see its skills.
      </p>
    );
  }

  if (state.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading skills…</p>;
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-danger-foreground" role="alert">
        Could not load the skill registry: {state.message}
      </p>
    );
  }

  const errorNote =
    actionError === null ? null : (
      <p className="text-sm text-danger-foreground" role="alert">
        {actionError}
      </p>
    );

  if (selected !== null) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => select(null)}>
            All skills
          </Button>
        </div>
        {errorNote}
        <SkillDetailView
          tenantId={tenantId}
          name={selected}
          now={now}
          onChanged={() => void reload()}
        />
        {createDialog}
      </div>
    );
  }

  const { skills, drafts } = state;

  if (skills.length === 0 && drafts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {errorNote}
        <RichEmptyState
          icon={<Sparkles />}
          title="No skills yet"
          description="A skill is a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent can pin and a workbench can install. Write one and publish it into this workbench's registry."
          actions={[
            {
              label: "New skill",
              variant: "primary",
              onClick: () => setCreateOpen(true),
            },
          ]}
        />
        {createDialog}
      </div>
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <label className="shell-panel-search">
          <Search aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            aria-label="Search skills"
          />
        </label>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> New skill
        </Button>
      </div>
      {errorNote}

      {drafts.length > 0 && (
        <Section
          title="Pending"
          description="Drafts nobody else can see yet. Publishing adds the skill to this workbench's registry."
        >
          <div className="flex flex-col gap-1">
            {drafts.map((draft) => (
              <SidebarItemRow
                key={draft.assetId}
                leading={<Sparkles />}
                name={
                  <span className="panel-row-copy">
                    <strong>{draft.name}</strong>
                    <span>{draft.description}</span>
                  </span>
                }
                meta={
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handlePublish(draft.name)}
                  >
                    Publish
                  </Button>
                }
              />
            ))}
          </div>
        </Section>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Sparkles />}
          title="No matching skills"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {filtered.map((skill) => (
            <SidebarItemRow
              key={skill.assetId}
              leading={<Sparkles />}
              name={
                <span className="panel-row-copy">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                </span>
              }
              meta={
                <span
                  className={
                    skill.scope === "tenant"
                      ? "panel-status is-ok"
                      : "panel-status is-muted"
                  }
                >
                  {skill.scope === "tenant" ? "Installed" : "Private"}
                </span>
              }
              onSelect={() => select(skill.name)}
            />
          ))}
        </div>
      )}
      {createDialog}
    </div>
  );
}
