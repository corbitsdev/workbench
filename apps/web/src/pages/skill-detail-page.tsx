// The skill detail page at `/skills/<name>` (CL-6416). One full page per
// skill, replacing the placeholder that stood at this route and absorbing
// the version-history panel the Skills roster used to carry inline — there
// is one skill editor now, and it lives here.
//
// Versioning is git: every save is a commit on the skill's own SKILL.md
// (`@corbits/skills`), so "the version list" is that commit history and
// "restore" is a new commit carrying an older content. Nothing on this
// page stores a version itself.
//
// A save is never silent. "Save…" opens a review step showing the diff
// between the version currently published and what is in the editor; the
// commit happens only when the reader confirms it, so nobody publishes a
// change they have not seen.

import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  PageShell,
  RichEmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  formatRelativeTime,
} from "@corbits/react-ui";
import { GitDiff, Lightning } from "@corbits/icons";
import { WorkbenchLoadingState } from "@corbits/chat-ui";
import { useCallback, useEffect, useState } from "react";

import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX, skillIdFromPath } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  listSkillVersions,
  loadSkill,
  loadSkillAtVersion,
  restoreSkillVersion,
  setSkillScope,
  updateSkill,
  type PinnedByEntry,
  type SkillDetail,
  type SkillVersion,
} from "../skills-api";
import { DiffHeading, DiffView } from "./diff-view";

type Loaded = {
  readonly skill: SkillDetail;
  readonly pinnedBy: readonly PinnedByEntry[];
  readonly versions: readonly SkillVersion[];
};

type PageState =
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & Loaded)
  | { readonly status: "error"; readonly message: string };

type Comparison = {
  readonly version: SkillVersion;
  readonly body: string;
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** "Version 3 of 7" numbering: history is newest-first, so a row's number
 * counts up from the oldest commit. */
function versionLabel(total: number, index: number): string {
  return `Version ${String(total - index)}`;
}

export function SkillDetailPage({
  tenantId,
  name,
  now = Date.now(),
}: {
  readonly tenantId: string | null;
  readonly name: string;
  readonly now?: number;
}) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [draft, setDraft] = useState<{
    readonly description: string;
    readonly body: string;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  const reload = useCallback(async () => {
    if (tenantId === null) return;
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
      setDraft({
        description: detail.skill.description,
        body: detail.skill.body,
      });
      setComparison(null);
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    }
  }, [tenantId, name]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const crumbs = [
    { label: "Skills", href: SKILLS_PATH_PREFIX },
    { label: name },
  ];

  function frame(actions: React.ReactNode, body: React.ReactNode) {
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

  if (tenantId === null) {
    return frame(
      null,
      <p className="text-sm text-muted-foreground">
        Pick a workbench to see this skill.
      </p>,
    );
  }

  if (state.status === "error") {
    return frame(
      null,
      <RichEmptyState
        icon={<Lightning />}
        title="Couldn't load this skill"
        description="Something went wrong on our side. Try again in a moment."
        actions={[{ label: "Retry", onClick: () => void reload() }]}
      />,
    );
  }

  if (state.status === "loading" || draft === null) {
    return frame(null, <WorkbenchLoadingState title="Loading skill…" />);
  }

  const registryTenantId: string = tenantId;
  const { skill, pinnedBy, versions } = state;
  const shared = skill.scope === "tenant";
  const edited =
    draft.body !== skill.body || draft.description !== skill.description;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await reload();
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSave() {
    if (draft === null) return;
    setSaveError(null);
    setBusy(true);
    try {
      await updateSkill(registryTenantId, skill.name, {
        description: draft.description.trim(),
        body: draft.body,
      });
      setConfirming(false);
      await reload();
    } catch (cause) {
      setSaveError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function compare(version: SkillVersion) {
    if (comparison?.version.commitSha === version.commitSha) {
      setComparison(null);
      return;
    }
    try {
      const at = await loadSkillAtVersion(
        registryTenantId,
        skill.name,
        version.commitSha,
      );
      setComparison({ version, body: at.body });
    } catch (cause) {
      setState({ status: "error", message: messageOf(cause) });
    }
  }

  const saveAction = (
    <Button
      size="sm"
      type="button"
      disabled={!edited || busy}
      onClick={() => setConfirming(true)}
    >
      Save…
    </Button>
  );

  return frame(
    saveAction,
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {skill.name}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Updated {formatRelativeTime(skill.updatedAtIso, now)}
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
            onClick={() =>
              void run(() =>
                setSkillScope(
                  registryTenantId,
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

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <Section
            title="Description"
            description="Agents see this line — and only this line — when deciding whether to load the skill."
          >
            <Textarea
              id="skill-description"
              aria-label="Description"
              value={draft.description}
              rows={2}
              onChange={(event) =>
                setDraft({ description: event.target.value, body: draft.body })
              }
            />
          </Section>

          <Section
            title="Skill body"
            description="The instructions, tools, and guardrails this skill packages. Saving publishes a new version."
          >
            <Textarea
              id="skill-body"
              aria-label="Skill body"
              className="min-h-80 font-mono text-xs leading-relaxed"
              value={draft.body}
              rows={20}
              onChange={(event) =>
                setDraft({
                  description: draft.description,
                  body: event.target.value,
                })
              }
            />
            {edited ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Unsaved changes — “Save…” shows what will change before it is
                published.
              </p>
            ) : null}
          </Section>

          {comparison === null ? null : (
            <Section
              title={`${versionLabel(
                versions.length,
                versions.findIndex(
                  (entry) => entry.commitSha === comparison.version.commitSha,
                ),
              )} compared with the current version`}
              description={comparison.version.message}
            >
              <div className="flex flex-col gap-2">
                <DiffHeading
                  beforeLabel={formatRelativeTime(
                    comparison.version.committedAtIso,
                    now,
                  )}
                  afterLabel="Current"
                />
                <DiffView
                  before={comparison.body}
                  after={skill.body}
                  unchangedNotice="This version is identical to the current one."
                />
              </div>
            </Section>
          )}

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
        </div>

        <aside className="lg:w-96 lg:shrink-0">
          <Section
            title="Versions"
            description="Every saved version of this skill. Compare shows what changed; restore makes an older version the current one."
          >
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No saved versions yet.
              </p>
            ) : (
              <Table aria-label="Versions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((version, index) => (
                    <TableRow key={version.commitSha}>
                      <TableCell className="text-sm" title={version.commitSha}>
                        {versionLabel(versions.length, index)}
                        {version.current ? (
                          <Badge tone="success" className="ml-2">
                            current
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm">
                        {version.message}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {version.author}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatRelativeTime(version.committedAtIso, now)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={version.current || busy}
                            onClick={() => void compare(version)}
                          >
                            <GitDiff /> Compare
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={version.current || busy}
                            onClick={() =>
                              void run(() =>
                                restoreSkillVersion(
                                  registryTenantId,
                                  skill.name,
                                  version.commitSha,
                                ),
                              )
                            }
                          >
                            Restore
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Section>
        </aside>
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) setSaveError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review this save</DialogTitle>
            <DialogDescription>
              This is what publishing will change. The new version is only
              created when you confirm it.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {saveError !== null && (
              <p className="mb-3 text-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
            <div className="flex flex-col gap-4">
              {draft.description === skill.description ? null : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Description
                  </p>
                  <DiffView
                    before={skill.description}
                    after={draft.description}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Skill body
                </p>
                <DiffView
                  before={skill.body}
                  after={draft.body}
                  unchangedNotice="The skill body is unchanged."
                />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(false)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => void confirmSave()}
            >
              Confirm &amp; save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>,
  );
}

/**
 * Mount at `/skills/:name`: resolves the workbench this skill is read from
 * and the name the route carries. The page owns its own stage chrome.
 */
export function SkillDetailRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const name = skillIdFromPath(path);

  if (name === null) {
    return (
      <RichEmptyState
        icon={<Lightning />}
        title="No skill at this address"
        description="The link points at a skill name this workbench can't read."
      />
    );
  }

  return <SkillDetailPage tenantId={selectedTenantId} name={name} />;
}
