import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  useSkillLibrary,
  useSkillShareTargets,
  type SkillLibraryItem,
} from "../hooks/use-skills";
import { getMe } from "../lib/hub-api";

const W = "rgba(255,255,255,.9)";
const W2 = "rgba(255,255,255,.45)";

// Decorative glyph drawn behind a skill tile's hero area, mirroring the
// artifact gallery's visual language. Driven entirely by `kind`.
function SkillGlyph({ kind }: { kind: "code" | "doc" | "grid" | "nodes" }) {
  switch (kind) {
    case "code":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <path
            d="M44 26 L28 40 L44 54"
            fill="none"
            stroke={W}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M76 26 L92 40 L76 54"
            fill="none"
            stroke={W}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <line
            x1="66"
            y1="22"
            x2="54"
            y2="58"
            stroke={W2}
            strokeWidth="5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "doc":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 5 }).map((_, i) => (
            <rect
              key={i}
              x="16"
              y={16 + i * 11}
              width={i % 2 ? 60 : 88}
              height="5"
              rx="2.5"
              fill={i ? W2 : W}
            />
          ))}
        </svg>
      );
    case "grid":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          {Array.from({ length: 15 }).map((_, i) => (
            <rect
              key={i}
              x={12 + (i % 5) * 20}
              y={14 + Math.floor(i / 5) * 20}
              width="15"
              height="15"
              rx="2"
              fill={i % 3 ? W2 : W}
            />
          ))}
        </svg>
      );
    case "nodes":
      return (
        <svg className="h-full w-full" viewBox="0 0 120 80">
          <line x1="30" y1="26" x2="70" y2="50" stroke={W2} strokeWidth="2" />
          <line x1="70" y1="50" x2="94" y2="24" stroke={W2} strokeWidth="2" />
          <line x1="30" y1="26" x2="40" y2="60" stroke={W2} strokeWidth="2" />
          <circle cx="30" cy="26" r="7" fill={W} />
          <circle cx="70" cy="50" r="9" fill={W} />
          <circle cx="94" cy="24" r="6" fill={W2} />
          <circle cx="40" cy="60" r="6" fill={W2} />
        </svg>
      );
  }
}

const GLYPHS = ["code", "doc", "grid", "nodes"] as const;
// White glyphs/badges require a dark fill — mirror the artifact gallery palette,
// which deliberately omits the light `bg-cream` for this reason.
const FILLS = ["bg-orange", "bg-blue", "bg-green", "bg-charcoal"] as const;

// Deterministic, stable visual per skill so the grid looks varied but never
// reshuffles between renders.
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

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
  const glyph = GLYPHS[hash % GLYPHS.length];
  const fill = FILLS[hash % FILLS.length];
  const title = skill.displayName ?? skill.name;

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
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface transition-transform duration-300 ease-spring hover:-translate-y-1.5 hover:rotate-[-1deg] hover:scale-[1.02] hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-orange"
    >
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {accessLabel}
      </span>
      <div
        className={`relative grid h-[112px] place-items-center overflow-hidden ${fill}`}
      >
        <div className="h-full w-full transition-transform duration-500 ease-spring group-hover:scale-[1.06]">
          <SkillGlyph kind={glyph} />
        </div>
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
        (skill.displayName ?? "").toLowerCase().includes(q),
    );
  }, [query, skillsQuery.data]);

  const isSearching = query.trim().length > 0;

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section className="flex min-h-full flex-1 flex-col overflow-y-auto rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
        <div className="flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7">
          <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">
            Skills
          </h1>
          <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
            {filteredLibrary.length} items
          </span>
          <div className="flex-1" />
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-[34px] w-[180px] rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
          />
          <button
            type="button"
            onClick={() => navigate("/skills/new")}
            className="flex items-center gap-[7px] rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[7px] text-[12.5px] font-semibold text-cream transition-colors"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Skill
          </button>
        </div>

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
        </div>
      </section>
    </div>
  );
}
