// Skills master-detail. There is no hub skill registry yet, so this page
// keeps session-local drafts created via the dialog. Empty is honest;
// once a draft exists, cards show access/owner/updated/version and the
// detail pane shows about + pinned-by + version history with Restore.

import {
  Badge,
  Button,
  LibrarySearchInput,
  PageShell,
  RichEmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ViewToggle,
  formatRelativeTime,
} from "@corbits/react-ui";
import type { ViewMode } from "@corbits/react-ui";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { CreateSkillDialog, type SkillDraft } from "./create-skill-dialog";

export type SkillVersion = {
  readonly version: string;
  readonly note: string;
  readonly who: string;
  readonly whenIso: string;
  readonly current: boolean;
};

export type Skill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly access: "Shared" | "Private";
  readonly owner: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly pinnedBy: readonly string[];
  readonly versions: readonly SkillVersion[];
  /** True when this row only lives in the current browser session. */
  readonly sessionLocal: boolean;
};

function accessTone(access: Skill["access"]): "info" | "neutral" {
  return access === "Shared" ? "info" : "neutral";
}

function SkillCard({
  skill,
  selected,
  now,
  onSelect,
}: {
  readonly skill: Skill;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors",
        selected
          ? "border-primary ring-1 ring-primary/40"
          : "border-border hover:border-primary/40",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone={accessTone(skill.access)}>{skill.access}</Badge>
        <span className="font-mono text-[0.7rem] text-muted-foreground">
          v{skill.version}
        </span>
      </div>
      <span className="truncate text-sm font-semibold">{skill.name}</span>
      <span className="line-clamp-2 text-xs text-muted-foreground">
        {skill.description === "" ? "No description" : skill.description}
      </span>
      <span className="truncate text-[0.7rem] text-muted-foreground">
        {skill.owner} · {formatRelativeTime(skill.updatedAt, now)}
        {skill.sessionLocal ? " · session draft" : ""}
      </span>
    </button>
  );
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
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 sm:p-6">
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

function draftToSkill(draft: SkillDraft, id: string, nowIso: string): Skill {
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

/**
 * Skills page: toolbar when non-empty, dense cards, detail pane with
 * about / pinned-by / version history. Zero skills → empty state only
 * (no inert search chrome). Auto-selects the first skill when the list
 * becomes non-empty.
 */
export function SkillsPage({
  skills: initialSkills = [],
  now = Date.now(),
}: {
  readonly skills?: readonly Skill[];
  readonly now?: number;
} = {}) {
  const [skills, setSkills] = useState<readonly Skill[]>(initialSkills);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSkills[0]?.id ?? null,
  );

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  // Auto-select first skill when the list becomes non-empty and nothing
  // is selected (or the selection disappeared).
  useEffect(() => {
    if (skills.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !skills.some((s) => s.id === selectedId)) {
      const first = skills[0];
      if (first !== undefined) setSelectedId(first.id);
    }
  }, [skills, selectedId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const selected =
    selectedId === null
      ? null
      : (skills.find((s) => s.id === selectedId) ?? null);

  if (skills.length === 0) {
    return (
      <>
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Sparkles />}
            title="No skills yet"
            description="A skill is a named, reusable capability — instructions, tools, and guardrails packaged together — that an agent definition can declare and a bench can install. There's no skill registry on the hub yet; drafts you create stay in this session only."
            actions={[
              {
                label: "Create skill",
                onClick: () => setCreateOpen(true),
                variant: "primary",
              },
            ]}
          />
        </PageShell>
        <CreateSkillDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(draft) => {
            const id = `skill_local_${crypto.randomUUID()}`;
            const next = draftToSkill(draft, id, new Date(now).toISOString());
            setSkills((prev) => [next, ...prev]);
            setSelectedId(id);
            setCreateOpen(false);
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="page-toolbar">
        <LibrarySearchInput
          label="Search skills"
          value={query}
          onChange={setQuery}
        />
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          Create skill
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className={[
            "min-h-0 overflow-auto border-r border-border",
            selected === null ? "flex-1" : "w-full max-w-sm shrink-0",
          ].join(" ")}
        >
          {filtered.length === 0 ? (
            <div className="p-6">
              <RichEmptyState
                icon={<Sparkles />}
                title="Nothing matches"
                description={`No skill matches "${query}".`}
              />
            </div>
          ) : viewMode === "rows" ? (
            <div className="p-3">
              <Table aria-label="Skills">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((skill) => (
                    <TableRow
                      key={skill.id}
                      className="cursor-pointer"
                      data-state={
                        selectedId === skill.id ? "selected" : undefined
                      }
                      onClick={() => setSelectedId(skill.id)}
                    >
                      <TableCell className="font-medium">
                        {skill.name}
                      </TableCell>
                      <TableCell>
                        <Badge tone={accessTone(skill.access)}>
                          {skill.access}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        v{skill.version}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelativeTime(skill.updatedAt, now)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 p-3">
              {filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  selected={selectedId === skill.id}
                  now={now}
                  onSelect={() => setSelectedId(skill.id)}
                />
              ))}
            </div>
          )}
        </div>
        {selected !== null ? (
          <div className="min-h-0 min-w-0 flex-1">
            <SkillDetail
              skill={selected}
              now={now}
              onRestore={(version) => {
                // Registry-backed restore is not wired; only non-session
                // skills would flip current. Keep the surface honest.
                setSkills((prev) =>
                  prev.map((s) => {
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
          </div>
        ) : null}
      </div>
      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(draft) => {
          const id = `skill_local_${crypto.randomUUID()}`;
          const next = draftToSkill(draft, id, new Date(now).toISOString());
          setSkills((prev) => [next, ...prev]);
          setSelectedId(id);
          setCreateOpen(false);
        }}
      />
    </>
  );
}

export function SkillsRoute() {
  return <SkillsPage />;
}
