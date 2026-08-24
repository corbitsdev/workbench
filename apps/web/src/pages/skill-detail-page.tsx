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
// A save is never silent, and never blind:
//
//   * "Review" opens a review step showing the diff between the published
//     version and what is in the editor; the commit happens only on
//     confirm.
//   * The save carries the version the editor was seeded from, so if
//     somebody else saved in the meantime the registry refuses it (409)
//     and the review re-opens against what is actually published now,
//     rather than burying their work.
//
// The editor buffer is newline-normalized, so the bytes reviewed in the
// diff are exactly the bytes the confirm writes.
//
// The page reads top to bottom in one column: who can see the skill, the
// description agents match on, the body, then the full version history.
// History was a narrow side column, which left every one of its columns
// truncated to a stub — a table nobody can read teaches nothing, so it now
// gets the full width it needs.

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
import { ApiQueryError, describeApiError } from "@corbits/api-query";
import { normalizeNewlines } from "@corbits/text-diff";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX, skillIdFromPath } from "../path-ids";
import { skillDisplayName } from "../skill-display-name";
import { skillVersionSavedBy } from "../skill-version-author";
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

type Draft = { readonly description: string; readonly body: string };

type Loaded = {
  readonly skill: SkillDetail;
  readonly pinnedBy: readonly PinnedByEntry[];
  readonly versions: readonly SkillVersion[];
};

type PageState =
  | { readonly status: "loading" }
  | ({ readonly status: "ready" } & Loaded)
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly message: string };

type Comparison = { readonly version: SkillVersion; readonly body: string };

function statusOf(cause: unknown): number | undefined {
  return cause instanceof ApiQueryError ? cause.status : undefined;
}

/** "Version 3 of 7" numbering: history is newest-first, so a row's number
 * counts up from the oldest commit. */
function versionLabel(total: number, index: number): string {
  return `Version ${String(total - index)}`;
}

function draftOf(skill: SkillDetail): Draft {
  return {
    description: normalizeNewlines(skill.description),
    body: normalizeNewlines(skill.body),
  };
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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  /** Reads the skill and its history. `keepDraft` protects unsaved edits:
   * a background re-read must never quietly discard what someone typed. */
  const read = useCallback(
    async (options: {
      readonly keepDraft: boolean;
    }): Promise<Loaded | null> => {
      if (tenantId === null) return null;
      if (!options.keepDraft) setState({ status: "loading" });
      try {
        const [detail, versions] = await Promise.all([
          loadSkill(tenantId, name),
          listSkillVersions(tenantId, name),
        ]);
        const loaded: Loaded = {
          skill: detail.skill,
          pinnedBy: detail.pinnedBy,
          versions,
        };
        setState({ status: "ready", ...loaded });
        if (!options.keepDraft) {
          setDraft(draftOf(detail.skill));
          setComparison(null);
        }
        return loaded;
      } catch (cause) {
        if (options.keepDraft) {
          setActionError(describeApiError(cause, "re-reading this skill"));
          return null;
        }
        setState(
          statusOf(cause) === 404
            ? { status: "missing" }
            : {
                status: "error",
                message: describeApiError(cause, "loading this skill"),
              },
        );
        return null;
      }
    },
    [tenantId, name],
  );

  useEffect(() => {
    void read({ keepDraft: false });
  }, [read]);

  const crumbs = [
    { label: "Skills", href: SKILLS_PATH_PREFIX },
    { label: name },
  ];

  function frame(actions: ReactNode, body: ReactNode) {
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

  if (state.status === "missing") {
    return frame(
      null,
      <RichEmptyState
        icon={<Lightning />}
        title={`No skill named “${name}”`}
        description="It may have been renamed, or it belongs to a workbench you can't see."
        actions={[{ label: "Back to Skills", href: SKILLS_PATH_PREFIX }]}
      />,
    );
  }

  if (state.status === "error") {
    return frame(
      null,
      <RichEmptyState
        icon={<Lightning />}
        title="Couldn't load this skill"
        description={state.message}
        actions={[
          { label: "Retry", onClick: () => void read({ keepDraft: false }) },
        ]}
      />,
    );
  }

  if (state.status === "loading" || draft === null) {
    return frame(null, <WorkbenchLoadingState title="Loading skill…" />);
  }

  const registryTenantId: string = tenantId;
  const { skill, pinnedBy, versions } = state;
  const published = draftOf(skill);
  const headSha =
    versions.find((version) => version.current)?.commitSha ?? null;
  const shared = skill.scope === "tenant";
  const edited =
    draft.body !== published.body ||
    draft.description !== published.description;

  /** A side action (visibility, restore, compare): its failure belongs next
   * to the action, never in place of the whole page, and its success never
   * throws away a dirty draft. */
  async function runSideAction(action: () => Promise<unknown>) {
    setActionError(null);
    setBusy(true);
    try {
      await action();
      await read({ keepDraft: edited });
    } catch (cause) {
      setActionError(describeApiError(cause, "saving that change"));
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
        description: draft.description,
        body: draft.body,
        expectedHeadSha: headSha,
      });
      setConfirming(false);
      setStaleNotice(null);
      await read({ keepDraft: false });
    } catch (cause) {
      if (statusOf(cause) === 409) {
        // Somebody else published while this edit was open. Re-read, keep
        // the typed edit, and leave the review open — now diffing against
        // what is actually published.
        const reread = await read({ keepDraft: true });
        setStaleNotice(
          reread === null
            ? "Someone else saved this skill while you were editing. Reload to see their version."
            : "Someone else saved this skill while you were editing. The diff below now compares your edit with their version — confirm to save on top of it.",
        );
      } else {
        setSaveError(describeApiError(cause, "saving this skill"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function compare(version: SkillVersion) {
    if (comparison?.version.commitSha === version.commitSha) {
      setComparison(null);
      return;
    }
    setActionError(null);
    try {
      const at = await loadSkillAtVersion(
        registryTenantId,
        skill.name,
        version.commitSha,
      );
      setComparison({ version, body: at.body });
    } catch (cause) {
      setActionError(describeApiError(cause, "reading that version"));
    }
  }

  const saveAction = (
    <Button
      size="sm"
      type="button"
      disabled={!edited || busy}
      onClick={() => {
        setSaveError(null);
        setStaleNotice(null);
        setConfirming(true);
      }}
    >
      Review
    </Button>
  );

  return frame(
    saveAction,
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {skillDisplayName(skill)}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Updated {formatRelativeTime(skill.updatedAtIso, now)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {shared
              ? "Everyone in this workbench can use this skill."
              : "Only you can use this skill."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void runSideAction(() =>
                setSkillScope(
                  registryTenantId,
                  skill.name,
                  shared ? "private" : "tenant",
                ),
              )
            }
          >
            {shared ? "Make it private to me" : "Share with everyone here"}
          </Button>
        </div>
      </header>

      {actionError === null ? null : (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-6">
        <Section
          title="Description"
          description="A short summary of what this skill does and when to use it."
        >
          <Textarea
            id="skill-description"
            aria-label="Description"
            value={draft.description}
            rows={2}
            onChange={(event) =>
              setDraft({
                description: normalizeNewlines(event.target.value),
                body: draft.body,
              })
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
                body: normalizeNewlines(event.target.value),
              })
            }
          />
          {edited ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Unsaved changes — “Review” shows what will change before it is
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

        <Section
          title="Version history"
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
                  <TableHead className="w-40">Version</TableHead>
                  <TableHead>What changed</TableHead>
                  <TableHead className="w-40">Saved by</TableHead>
                  <TableHead className="w-36">When</TableHead>
                  <TableHead className="w-56 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((version, index) => (
                  <TableRow key={version.commitSha}>
                    <TableCell
                      className="text-sm whitespace-nowrap"
                      title={version.commitSha}
                    >
                      {versionLabel(versions.length, index)}
                      {version.current ? (
                        <Badge tone="success" className="ml-2">
                          current
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{version.message}</TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                      {skillVersionSavedBy(version.author)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
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
                            void runSideAction(() =>
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
      </div>

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next) {
            setSaveError(null);
            setStaleNotice(null);
          }
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
            {staleNotice !== null && (
              <p
                className="mb-3 text-sm text-foreground"
                role="alert"
                data-testid="save-stale-notice"
              >
                {staleNotice}
              </p>
            )}
            {saveError !== null && (
              <p className="mb-3 text-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
            <div className="flex flex-col gap-4">
              {draft.description === published.description ? null : (
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Description
                  </p>
                  <DiffView
                    before={published.description}
                    after={draft.description}
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Skill body
                </p>
                <DiffView
                  before={published.body}
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
