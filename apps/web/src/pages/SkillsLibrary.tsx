import {
  Button,
  CATALOG_GLYPH_FILLS,
  CATALOG_GLYPH_KINDS,
  CatalogGlyph,
  catalogCardClassName,
  DataTable,
  hashString,
  LibraryPageHeader,
  LibrarySearchInput,
  PagePanel,
  toHumanLabel,
  useViewMode,
  ViewToggle,
  type DataTableColumn,
} from "@workbench/ui";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  useSkillLibrary,
  useSkillShareTargets,
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
  const title = skill.displayName ?? toHumanLabel(skill.name);

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
  const shareTargetsQuery = useSkillShareTargets(tenantId);

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
        toHumanLabel(skill.name).toLowerCase().includes(q) ||
        (skill.displayName ?? "").toLowerCase().includes(q),
    );
  }, [query, skillsQuery.data]);

  const isSearching = query.trim().length > 0;

  const skillRowColumns: DataTableColumn<SkillLibraryItem>[] = [
    {
      key: "name",
      header: "Name",
      className: "font-medium text-text",
      render: (s) => s.displayName ?? s.name,
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

  return (
    <PagePanel>
      <LibraryPageHeader title="Skills" count={filteredLibrary.length}>
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
      </LibraryPageHeader>

      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
        {skillsQuery.isLoading && (
          <div className="py-10 text-[13px] text-text-3">Loading skills…</div>
        )}
        {skillsQuery.isError && (
          <div className="py-10 text-[13px] text-text-3">
            Could not load skills.
          </div>
        )}
        {!skillsQuery.isLoading &&
          !skillsQuery.isError &&
          filteredLibrary.length === 0 && (
            <div className="py-10 text-[13px] text-text-3">
              {isSearching ? (
                <>No results for &ldquo;{query.trim()}&rdquo;.</>
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
        {!skillsQuery.isLoading &&
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
