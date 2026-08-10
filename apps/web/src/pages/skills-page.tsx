// Skills master-detail. There is no hub skill registry yet, so drafts
// live in a session store shared with col2. Stage is detail-only (or
// empty “select from sidebar”); the list is shell col2.

import {
  Badge,
  Button,
  EmptyState,
  PageShell,
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
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { CreateSkillDialog, type SkillDraft } from "./create-skill-dialog";
import {
  addSessionSkill,
  updateSessionSkills,
  useSessionSkills,
  type Skill,
  type SkillVersion,
} from "./skills-session";

export type { Skill, SkillVersion };

const SKILLS_PATH_PREFIX = "/skills";

export function skillIdFromPath(path: string): string | null {
  if (!path.startsWith(`${SKILLS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(SKILLS_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

function accessTone(access: Skill["access"]): "info" | "neutral" {
  return access === "Shared" ? "info" : "neutral";
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

/**
 * Skills stage: list lives in shell col2; stage is detail only. Create is
 * pageBand / workbench:skills:create. `skills` prop injects rows for tests;
 * production uses the session store via SkillsRoute.
 */
export function SkillsPage({
  skills: controlledSkills,
  now = Date.now(),
  path = SKILLS_PATH_PREFIX,
  navigate,
  initialSelectedId,
  onSkillsChange,
}: {
  readonly skills?: readonly Skill[];
  readonly now?: number;
  readonly path?: string;
  readonly navigate?: (to: string) => void;
  /** Injectable selection for tests that assert detail without routing. */
  readonly initialSelectedId?: string;
  /** Called when the controlled list mutates (tests / non-session hosts). */
  readonly onSkillsChange?: (next: readonly Skill[]) => void;
} = {}) {
  const sessionSkills = useSessionSkills();
  const skills = controlledSkills ?? sessionSkills;
  const [createOpen, setCreateOpen] = useState(false);
  const pathSelectedId = skillIdFromPath(path);
  const selectedId =
    pathSelectedId ??
    initialSelectedId ??
    // Tests that inject skills without a path id still get the first row
    // selected so detail assertions stay one-shot SSR friendly.
    (controlledSkills !== undefined ? (controlledSkills[0]?.id ?? null) : null);

  // Mock master-detail: when the list is non-empty and the path is bare
  // /skills, open the first skill. Real registry routing can drop this.
  useEffect(() => {
    if (pathSelectedId !== null || navigate === undefined) return;
    if (skills.length === 0) return;
    const first = skills[0];
    if (first === undefined) return;
    navigate(`${SKILLS_PATH_PREFIX}/${encodeURIComponent(first.id)}`);
  }, [pathSelectedId, skills, navigate]);

  useEffect(() => {
    const onCreate = () => setCreateOpen(true);
    window.addEventListener("workbench:skills:create", onCreate);
    return () =>
      window.removeEventListener("workbench:skills:create", onCreate);
  }, []);

  const selected =
    selectedId === null
      ? null
      : (skills.find((s) => s.id === selectedId) ?? null);

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
    navigate?.(`${SKILLS_PATH_PREFIX}/${encodeURIComponent(id)}`);
  }

  if (skills.length === 0) {
    return (
      <>
        <PageShell width="full" className="page-fill">
          <div className="flex flex-1 items-center justify-center p-6">
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
          </div>
        </PageShell>
        <CreateSkillDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={handleCreated}
        />
      </>
    );
  }

  return (
    <>
      {/* List lives in shell col2; stage is detail only. */}
      <PageShell width="full" className="page-fill">
        {selected !== null ? (
          <SkillDetail
            skill={selected}
            now={now}
            onRestore={(version) => {
              // Registry-backed restore is not wired; only non-session
              // skills would flip current. Keep the surface honest.
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
        ) : selectedId !== null ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<Sparkles />}
              title="Skill not found"
              description="That draft is not in this session. Pick another from the sidebar."
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<Sparkles />}
              title="Select a skill"
              description="Pick a skill from the sidebar to see its about, pins, and version history."
            />
          </div>
        )}
      </PageShell>
      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </>
  );
}

export function SkillsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  return <SkillsPage path={path} navigate={navigate} />;
}
