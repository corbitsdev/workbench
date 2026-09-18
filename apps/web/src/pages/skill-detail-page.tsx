// No stock route for version history, pinned-by list, or visibility flag,
// so those stay out of this page. SKILL.md content, though, is readable
// and writable the same way agent source is (see `skill-source.ts`).
import {
  Button,
  PageShell,
  RichEmptyState,
  Section,
  Textarea,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import { Lightning } from "@/lib/icons";
import { WorkbenchLoadingState } from "@/chat";
import { ApiQueryError, describeApiError } from "@/lib/api-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";

import { tenantKeys } from "../query-client";

import { useBench } from "../bench-context";
import { SKILLS_PATH_PREFIX, skillIdFromPath } from "../path-ids";
import { skillDisplayName } from "../skill-display-name";
import { readSkillSource, writeSkillSource } from "../skill-source";
import { StageTopBar } from "../shell/stage-top-bar";
import { loadSkill, type SkillSummary } from "../skills-api";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

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

      <SkillSourceEditor tenantId={tenantId} skill={skill} />
    </div>,
  );
}

/** SKILL.md's editor: a read `useQuery`, handed off to a `SkillDraftEditor`
 * keyed on the fetched content so its draft state seeds once per value
 * read rather than through an effect. */
function SkillSourceEditor({
  tenantId,
  skill,
}: {
  readonly tenantId: string;
  readonly skill: SkillSummary;
}) {
  const queryClient = useQueryClient();
  const sourceKey = [...tenantKeys.skills(tenantId), skill.assetId, "source"] as const;
  const source = useQuery({
    queryKey: sourceKey,
    queryFn: () => readSkillSource(tenantId, skill.assetId, skill.name),
  });

  const save = useMutation({
    mutationFn: (content: string) => writeSkillSource(tenantId, skill.assetId, skill.name, content),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: sourceKey });
      toast("Saved SKILL.md");
    },
    onError: (cause) => toast(`Couldn't save SKILL.md: ${errorText(cause)}`),
  });

  if (source.isError) {
    return (
      <Section title="SKILL.md">
        <RichEmptyState
          icon={<Lightning />}
          title="Couldn't load SKILL.md"
          description={errorText(source.error)}
          actions={[{ label: "Retry", onClick: () => void source.refetch() }]}
        />
      </Section>
    );
  }

  return (
    <Section title="SKILL.md" description="This skill's instructions, read from its own repo.">
      {source.data === undefined ? (
        <Textarea value="" disabled className="min-h-[320px] font-mono text-[0.8125rem]" />
      ) : (
        <SkillDraftEditor
          key={source.data}
          initial={source.data}
          saving={save.isPending}
          onSave={(content) => save.mutate(content)}
        />
      )}
    </Section>
  );
}

/** The draft textarea and Save button for one fetched `SKILL.md` value.
 * Keyed by its caller on that value, so `useState(initial)` seeds once
 * per fetch/save cycle rather than through an effect. */
function SkillDraftEditor({
  initial,
  saving,
  onSave,
}: {
  readonly initial: string;
  readonly saving: boolean;
  readonly onSave: (content: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const dirty = draft !== initial;

  return (
    <div className="flex flex-col gap-3">
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-[320px] font-mono text-[0.8125rem]"
        placeholder="# Skill instructions"
      />
      <div>
        <Button type="button" onClick={() => onSave(draft)} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
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
