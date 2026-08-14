// Settings · Skills: session drafts (CL-5990). There is no hub skill
// registry yet, so drafts live in the same session store shared across
// mounts (see `../skills-session.ts`). Formerly its own rail destination
// (`/skills`, `skills-page.tsx` + shell col2's `SkillsFeedBand`); both the
// stage detail and the list now live together here, self-contained, since a
// settings section has no separate col2 list to lean on.

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
import { useEffect, useState } from "react";

import { consumePendingNewSkill } from "../command-palette-actions";
import {
  addSessionSkill,
  updateSessionSkills,
  useSessionSkills,
  type Skill,
} from "../skills-session";
import { CreateSkillDialog, type SkillDraft } from "./create-skill-dialog";

function accessTone(access: Skill["access"]): "info" | "neutral" {
  return access === "Shared" ? "info" : "neutral";
}

export function draftToSkill(
  draft: SkillDraft,
  id: string,
  nowIso: string,
): Skill {
  return {
    id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    body: draft.body,
    access: "Private",
    owner: "You",
    updatedAt: nowIso,
    version: "0.1.0",
    pinnedBy: [],
    versions: [
      {
        version: "0.1.0",
        note: "Session draft",
        who: "You",
        whenIso: nowIso,
        current: true,
      },
    ],
    sessionLocal: true,
  };
}

function SkillDetail({
  skill,
  now,
  onRestore,
}: {
  readonly skill: Skill;
  readonly now: number;
  readonly onRestore: (version: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {skill.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {skill.description === ""
              ? "No description yet."
              : skill.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={accessTone(skill.access)}>{skill.access}</Badge>
          <Badge tone="neutral">v{skill.version}</Badge>
          {skill.sessionLocal ? (
            <Badge tone="warning">Session draft</Badge>
          ) : null}
        </div>
      </header>

      <Section title="About" description="What this skill packages.">
        <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
          {skill.body === "" ? "(empty body)" : skill.body}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Owner {skill.owner} · updated{" "}
          {formatRelativeTime(skill.updatedAt, now)}
        </p>
      </Section>

      <Section
        title="Pinned by"
        description="Agents that currently declare this skill."
      >
        {skill.pinnedBy.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents pin this skill yet.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {skill.pinnedBy.map((name) => (
              <li key={name}>
                <Badge tone="neutral">{name}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Version history"
        description="Restore rewinds the live version. Session drafts have only the draft version until a registry exists."
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
            {skill.versions.map((ver) => (
              <TableRow key={ver.version}>
                <TableCell className="font-mono text-xs">
                  v{ver.version}
                  {ver.current ? (
                    <Badge tone="success" className="ml-2">
                      current
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm">{ver.note}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {ver.who}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelativeTime(ver.whenIso, now)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={ver.current || skill.sessionLocal}
                    title={
                      skill.sessionLocal
                        ? "Restore needs a skill registry"
                        : ver.current
                          ? "Already current"
                          : `Restore v${ver.version}`
                    }
                    onClick={() => onRestore(ver.version)}
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
 * Settings · Skills: session drafts. `navigate` and `entityId` come from
 * the settings section context (see `../settings-workspace-sections.tsx`);
 * `skills`/`now`/`onSkillsChange` are injectable for tests, mirroring the
 * former `SkillsPage`'s controlled-list escape hatch.
 */
export function SkillsSettingsSection({
  navigate,
  entityId,
  skills: controlledSkills,
  now = Date.now(),
  onSkillsChange,
}: {
  readonly navigate?: (to: string) => void;
  readonly entityId?: string | null;
  readonly skills?: readonly Skill[];
  readonly now?: number;
  readonly onSkillsChange?: (next: readonly Skill[]) => void;
}) {
  const sessionSkills = useSessionSkills();
  const skills = controlledSkills ?? sessionSkills;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(entityId ?? null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (consumePendingNewSkill()) setCreateOpen(true);
  }, []);

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  function select(id: string | null) {
    setSelectedId(id);
    navigate?.(
      id === null
        ? "/settings/skills"
        : `/settings/skills/${encodeURIComponent(id)}`,
    );
  }

  function commitSkills(next: readonly Skill[]): void {
    if (controlledSkills !== undefined) {
      onSkillsChange?.(next);
      return;
    }
    updateSessionSkills(() => next);
  }

  function handleCreated(draft: SkillDraft): void {
    const id = `skill_local_${crypto.randomUUID()}`;
    const next = draftToSkill(draft, id, new Date(now).toISOString());
    if (controlledSkills !== undefined) {
      onSkillsChange?.([next, ...controlledSkills]);
    } else {
      addSessionSkill(next);
    }
    setCreateOpen(false);
    select(id);
  }

  const selected =
    selectedId === null
      ? null
      : (skills.find((s) => s.id === selectedId) ?? null);

  const createDialog = (
    <CreateSkillDialog
      open={createOpen}
      onOpenChange={setCreateOpen}
      onCreated={handleCreated}
    />
  );

  if (skills.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <RichEmptyState
          icon={<Sparkles />}
          title="No skills yet"
          description="A skill is a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent definition can declare and a bench can install. There's no skill registry on the hub yet; drafts you create stay in this session only."
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

  if (selected !== null) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => select(null)}>
            All skills
          </Button>
        </div>
        <SkillDetail
          skill={selected}
          now={now}
          onRestore={(version) => {
            commitSkills(
              skills.map((s) => {
                if (s.id !== selected.id || s.sessionLocal) return s;
                return {
                  ...s,
                  version,
                  versions: s.versions.map((v) => ({
                    ...v,
                    current: v.version === version,
                  })),
                  updatedAt: new Date(now).toISOString(),
                };
              }),
            );
          }}
        />
        {createDialog}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered =
    q === ""
      ? skills
      : skills.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
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
              key={skill.id}
              leading={<Sparkles />}
              name={
                <span className="panel-row-copy">
                  <strong>{skill.name}</strong>
                  <span>v{skill.version}</span>
                </span>
              }
              meta={
                <span
                  className={
                    skill.sessionLocal
                      ? "panel-status is-muted"
                      : "panel-status is-ok"
                  }
                >
                  {skill.sessionLocal ? "Draft" : "Installed"}
                </span>
              }
              onSelect={() => select(skill.id)}
            />
          ))}
        </div>
      )}
      {createDialog}
    </div>
  );
}
