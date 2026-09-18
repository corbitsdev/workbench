// The skill detail page at `/skills/<name>`.
//
// this used to be a full editor over `@corbits/skills`' own
// registry — description/body editing with diff review, restore-by-
// version off that asset's git history, a "pinned by" list, and a
// private/shared visibility toggle. That registry (and the workflow
// routes it served) was deleted: skills are native `kind:"skill"` hub
// assets now, and the stock asset routes (`@intx/hub-api`'s
// `routes/assets.ts`) carry only metadata — id, name, displayName,
// creator, timestamps. There is no stock route yet to read a skill's
// SKILL.md content, its version history, who has it pinned, or a
// scope/visibility flag, so none of that can be rendered here without
// vendoring a replacement surface. This page is scoped down to what the
// stock routes actually carry until one exists — see the PR body
// for the gap.
import { PageShell, RichEmptyState, Section, formatRelativeTime } from "@corbits/react-ui";
import { Lightning } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { ApiQueryError, describeApiError } from "@/lib/api-query";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, type ReactNode } from "react";

import { tenantKeys } from "../query-client";

import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX, skillIdFromPath } from "../path-ids";
import { skillDisplayName } from "../skill-display-name";
import { StageTopBar } from "../shell/stage-top-bar";
import { loadSkill, type SkillSummary } from "../skills-api";

type PageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly skill: SkillSummary }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly message: string };

function statusOf(cause: unknown): number | undefined {
  return cause instanceof ApiQueryError ? cause.status : undefined;
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
  const queryClient = useQueryClient();
  const queryKey = [...tenantKeys.skills(tenantId ?? "none"), name] as const;
  const detail = useQuery({
    queryKey,
    queryFn: async () => (await loadSkill(tenantId ?? "", name)).skill,
    enabled: tenantId !== null,
  });

  // The failure is the page state — missing and error render distinct
  // honest copy, so neither is reported beyond what the reader already sees.
  const state: PageState = detail.isError
    ? statusOf(detail.error) === 404
      ? { status: "missing" }
      : { status: "error", message: describeApiError(detail.error, "loading this skill") }
    : detail.data === undefined
      ? { status: "loading" }
      : { status: "ready", skill: detail.data };

  const read = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from tenantId + name
  }, [queryClient, tenantId, name]);

  const crumbs = [{ label: "Skills", href: SKILLS_PATH_PREFIX }, { label: name }];

  function frame(body: ReactNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={crumbs} />
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
      <p className="text-sm text-muted-foreground">Pick a workbench to see this skill.</p>,
    );
  }

  if (state.status === "missing") {
    return frame(
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
      <RichEmptyState
        icon={<Lightning />}
        title="Couldn't load this skill"
        description={state.message}
        actions={[{ label: "Retry", onClick: () => void read() }]}
      />,
    );
  }

  if (state.status === "loading") {
    return frame(<WorkbenchLoadingState title="Loading skill…" />);
  }

  const { skill } = state;

  return frame(
    <div className="flex flex-col gap-6">
      <header className="min-w-0">
        <h1 className="truncate text-lg font-semibold tracking-tight">{skillDisplayName(skill)}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Updated {formatRelativeTime(skill.updatedAtIso, now)}
        </p>
      </header>

      <Section
        title="Skill content"
        description="Not readable here yet: there is no stock Interchange route for a skill's SKILL.md content."
      >
        <p className="text-sm text-muted-foreground">
          This skill's description, instructions, version history, and pinned-by list lived in the
          workbench-specific skill registry removed by. They will return once a stock route for
          reading and writing skill content exists.
        </p>
      </Section>
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
