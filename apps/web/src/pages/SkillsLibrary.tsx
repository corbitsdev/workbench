import {
  Button,
  CATALOG_GLYPH_FILLS,
  CATALOG_GLYPH_KINDS,
  CatalogGlyph,
  catalogCardClassName,
  DataTable,
  hashString,
  AppPageChromeRow,
  LibrarySearchInput,
  PagePanel,
  skillTitle,
  useViewMode,
  ViewToggle,
  type DataTableColumn,
} from "@workbench/ui";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useSetPageChrome } from "../lib/page-chrome";
import { useQuery } from "@tanstack/react-query";
import {
  useApproveSkillDraft,
  useDiscardSkillDraft,
  useSkillDrafts,
  useSkillLibrary,
  useSkillShareTargets,
  type SkillDraftItem,
  type SkillLibraryItem,
} from "../hooks/use-skills";
import { getMe } from "../lib/hub-api";

function SkillCard({
  skill,
  accessLabel,
  index,
  onSelect,
}: {
  skill: SkillLibraryItem;
  accessLabel: string;
  index: number;
  onSelect: () => void;
}) {
  const hash = hashString(skill.id);
  const glyph = CATALOG_GLYPH_KINDS[hash % CATALOG_GLYPH_KINDS.length];
  const fill = CATALOG_GLYPH_FILLS[hash % CATALOG_GLYPH_FILLS.length];
  const title = skillTitle(skill);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={catalogCardClassName}
    >
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {accessLabel}
      </span>
      <div
        className={`relative grid h-[112px] place-items-center overflow-hidden ${fill}`}
      >
        <CatalogGlyph kind={glyph} />
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
          S{index.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="truncate text-[13.5px] font-semibold text-text">
          {title}
        </div>
        <div className="mt-0.5 flex items-center gap-[7px] font-mono text-[11px] text-text-3">
          <span className="truncate">{skill.ownerName ?? "—"}</span>·
          <span className="shrink-0">
            {new Date(skill.updatedAt).toLocaleDateString()}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SkillsLibrary() {
  const navigate = useNavigate();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const [query, setQuery] = useState("");
  const { mode: viewMode, setMode: setViewMode } = useViewMode("skills");

  const skillsQuery = useSkillLibrary(tenantId);
  const draftsQuery = useSkillDrafts(tenantId);
  const shareTargetsQuery = useSkillShareTargets(tenantId);
  const approveDraft = useApproveSkillDraft();
  const discardDraft = useDiscardSkillDraft();
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const accessLabel = (skill: SkillLibraryItem) => {
    if (skill.scope === "private") return "Private";
    const target = (shareTargetsQuery.data ?? []).find(
      (t) => t.tenantId === skill.accessTenantId,
    );
    return target ? target.name : "Shared";
  };

  const filteredLibrary = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skillsQuery.data ?? []).filter(
      (skill) =>
        !q ||
        skill.name.toLowerCase().includes(q) ||
        skillTitle(skill).toLowerCase().includes(q),
    );
  }, [query, skillsQuery.data]);

  const filteredDrafts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (draftsQuery.data ?? []).filter(
      (draft) =>
        !q ||
        draft.title.toLowerCase().includes(q) ||
        (draft.description ?? "").toLowerCase().includes(q),
    );
  }, [query, draftsQuery.data]);

  const isSearching = query.trim().length > 0;

  const onApprove = (draft: SkillDraftItem, scope: "tenant" | "private") => {
    setActionError(null);
    approveDraft
      .mutateAsync({ draftId: draft.id, scope, tenantId })
      .then((result) => {
        navigate(`/skills/${result.skill.id}`);
      })
      .catch((err: unknown) => {
        setActionError(
          err instanceof Error ? err.message : "Could not approve draft",
        );
      });
  };

  const onDiscard = (draft: SkillDraftItem) => {
    if (
      !window.confirm(`Discard draft “${draft.title}”? This cannot be undone.`)
    ) {
      return;
    }
    setActionError(null);
    discardDraft
      .mutateAsync({ draftId: draft.id, tenantId })
      .catch((err: unknown) => {
        setActionError(
          err instanceof Error ? err.message : "Could not discard draft",
        );
      });
  };

  const skillRowColumns: DataTableColumn<SkillLibraryItem>[] = [
    {
      key: "name",
      header: "Name",
      className: "font-medium text-text",
      render: (s) => skillTitle(s),
    },
    {
      key: "access",
      header: "Access",
      render: (s) => accessLabel(s),
    },
    {
      key: "owner",
      header: "Owner",
      render: (s) => s.ownerName ?? "—",
    },
    {
      key: "updated",
      header: "Updated",
      render: (s) => new Date(s.updatedAt).toLocaleDateString(),
    },
  ];

  const pageChrome = useMemo(
    () => (
      <AppPageChromeRow title="Skills" count={filteredLibrary.length}>
        <LibrarySearchInput
          label="Search skills"
          placeholder="Search skills"
          value={query}
          onChange={setQuery}
        />
        <ViewToggle mode={viewMode} onChange={setViewMode} />
        <Button
          type="button"
          variant="library"
          size="library"
          onClick={() => navigate("/skills/new")}
        >
          <Plus size={14} className="text-orange" />
          Add skill
        </Button>
      </AppPageChromeRow>
    ),
    [filteredLibrary.length, query, viewMode, setViewMode, navigate],
  );
  useSetPageChrome(pageChrome);

  return (
    <PagePanel>
      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
        {actionError && (
          <div className="mb-3 rounded-md border border-border bg-surface px-3 py-2 text-[12px] text-text">
            {actionError}
          </div>
        )}

        {draftsQuery.isLoading && (
          <div className="mb-4 text-[13px] text-text-3">
            Loading pending drafts…
          </div>
        )}
        {draftsQuery.isError && (
          <div className="mb-4 text-[13px] text-text-3">
            Could not load pending drafts.
          </div>
        )}

        {filteredDrafts.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
              Pending drafts ({filteredDrafts.length})
            </h2>
            <ul className="flex flex-col gap-2">
              {filteredDrafts.map((draft) => {
                const expanded = expandedDraftId === draft.id;
                const isRevision = Boolean(draft.existingSkillId);
                // Resolve the live skill name from the already-loaded library
                // so the reviewer sees which skill will be updated.
                const revisionTarget = draft.existingSkillId
                  ? (skillsQuery.data ?? []).find(
                      (s) => s.id === draft.existingSkillId,
                    )
                  : undefined;
                const revisionLabel = revisionTarget
                  ? `revises ${skillTitle(revisionTarget)}`
                  : isRevision
                    ? "revises existing skill"
                    : null;
                const busy =
                  (approveDraft.isPending || discardDraft.isPending) &&
                  (approveDraft.variables?.draftId === draft.id ||
                    discardDraft.variables?.draftId === draft.id);
                return (
                  <li
                    key={draft.id}
                    className="rounded-md border border-border bg-surface px-3 py-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-semibold text-text">
                          {draft.title}
                          {revisionLabel ? (
                            <span className="ml-2 text-[11px] font-normal text-text-3">
                              {revisionLabel}
                            </span>
                          ) : null}
                        </div>
                        {draft.description ? (
                          <div className="mt-0.5 line-clamp-2 text-[12px] text-text-3">
                            {draft.description}
                          </div>
                        ) : null}
                        <div className="mt-1 font-mono text-[11px] text-text-3">
                          Updated {new Date(draft.updatedAt).toLocaleString()}
                          {draft.files.length > 0
                            ? ` · ${draft.files.length} support file${draft.files.length === 1 ? "" : "s"}`
                            : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="library"
                          size="library"
                          disabled={busy}
                          onClick={() =>
                            setExpandedDraftId(expanded ? null : draft.id)
                          }
                        >
                          {expanded ? "Hide" : "Review"}
                        </Button>
                        {isRevision ? (
                          <Button
                            type="button"
                            variant="library"
                            size="library"
                            disabled={busy}
                            onClick={() => {
                              const targetName = revisionTarget
                                ? skillTitle(revisionTarget)
                                : draft.title;
                              if (
                                !window.confirm(
                                  `Publish a new version of “${targetName}”? This updates the live skill.`,
                                )
                              ) {
                                return;
                              }
                              onApprove(draft, "tenant");
                            }}
                          >
                            Publish new version
                          </Button>
                        ) : (
                          <>
                            <Button
                              type="button"
                              variant="library"
                              size="library"
                              disabled={busy}
                              onClick={() => onApprove(draft, "tenant")}
                              title="Save to the skill library visible in this workspace"
                            >
                              Save to library
                            </Button>
                            <Button
                              type="button"
                              variant="library"
                              size="library"
                              disabled={busy}
                              onClick={() => onApprove(draft, "private")}
                              title="Save as private to you only"
                            >
                              Save private
                            </Button>
                          </>
                        )}
                        <Button
                          type="button"
                          variant="library"
                          size="library"
                          disabled={busy}
                          onClick={() => onDiscard(draft)}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="mt-3 flex flex-col gap-3">
                        <div>
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-3">
                            SKILL.md
                          </div>
                          <pre className="max-h-72 overflow-auto rounded border border-border bg-[rgba(0,0,0,0.18)] p-3 text-[12px] leading-relaxed text-text whitespace-pre-wrap">
                            {draft.content}
                          </pre>
                        </div>
                        {draft.files.map((file) => (
                          <div key={file.path}>
                            <div className="mb-1 font-mono text-[11px] font-semibold text-text-3">
                              {file.path}
                            </div>
                            <pre className="max-h-48 overflow-auto rounded border border-border bg-[rgba(0,0,0,0.18)] p-3 text-[12px] leading-relaxed text-text whitespace-pre-wrap">
                              {file.content}
                            </pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* isPending, not isLoading: useSkillLibrary is `enabled`-gated on
            tenantId, and TanStack v5's isLoading (isPending && isFetching) is
            false while a disabled query sits with no data — using isLoading
            here would flash the "no skills" empty state on every load until
            tenantId resolves. isPending stays true through that window. */}
        {skillsQuery.isPending && (
          <div className="py-10 text-[13px] text-text-3">Loading skills…</div>
        )}
        {skillsQuery.isError && (
          <div className="py-10 text-[13px] text-text-3">
            Could not load skills.
          </div>
        )}
        {!skillsQuery.isPending &&
          !skillsQuery.isError &&
          filteredLibrary.length === 0 && (
            <div className="py-10 text-[13px] text-text-3">
              {isSearching ? (
                <>No results for &ldquo;{query.trim()}&rdquo;.</>
              ) : filteredDrafts.length > 0 ? (
                <>
                  Published skills will appear here after you approve a draft.
                </>
              ) : (
                <>
                  No skills yet.{" "}
                  <button
                    type="button"
                    onClick={() => navigate("/skills/new")}
                    className="text-orange hover:underline"
                  >
                    Add your first skill
                  </button>
                </>
              )}
            </div>
          )}
        {!skillsQuery.isPending &&
          !skillsQuery.isError &&
          filteredLibrary.length > 0 &&
          (viewMode === "rows" ? (
            <DataTable<SkillLibraryItem>
              caption="Skills"
              rows={filteredLibrary}
              getRowKey={(s) => s.id}
              onRowClick={(s) => navigate(`/skills/${s.id}`)}
              columns={skillRowColumns}
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
              {filteredLibrary.map((skill, i) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  accessLabel={accessLabel(skill)}
                  index={i + 1}
                  onSelect={() => navigate(`/skills/${skill.id}`)}
                />
              ))}
            </div>
          ))}
      </div>
    </PagePanel>
  );
}
