import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useToolsLibrary, type ToolSummary } from "../hooks/use-tools";
import { getMe } from "../lib/hub-api";

const W = "rgba(255,255,255,.9)";
const W2 = "rgba(255,255,255,.45)";

// Decorative glyph drawn behind a tool tile's hero area, mirroring the skills
// and artifact gallery visual language.
function ToolGlyph({ kind }: { kind: "code" | "doc" | "grid" | "nodes" }) {
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
const FILLS = ["bg-orange", "bg-blue", "bg-green", "bg-charcoal"] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function ToolCard({
  tool,
  index,
  onSelect,
}: {
  tool: ToolSummary;
  index: number;
  onSelect: () => void;
}) {
  // Group visuals by provider so tools from the same integration read as a set.
  const providerHash = hashString(tool.providerName);
  const glyph = GLYPHS[hashString(tool.name) % GLYPHS.length];
  const fill = FILLS[providerHash % FILLS.length];

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${tool.name}`}
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
        {tool.providerName}
      </span>
      <div
        className={`relative grid h-[112px] place-items-center overflow-hidden ${fill}`}
      >
        <div className="h-full w-full transition-transform duration-500 ease-spring group-hover:scale-[1.06]">
          <ToolGlyph kind={glyph} />
        </div>
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
          T{index.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="truncate font-mono text-[13px] font-semibold text-text">
          {tool.name}
        </div>
        <p className="mt-0.5 line-clamp-2 text-pretty text-[11px] text-text-3">
          {tool.description || "No description"}
        </p>
        {tool.version !== null && (
          <span className="mt-1.5 block font-mono text-[10px] text-text-3/70">
            v{tool.version}
          </span>
        )}
      </div>
    </div>
  );
}

export function ToolsLibrary() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const tenantId = meQuery.data?.personalTenantId ?? null;
  const toolsQuery = useToolsLibrary(tenantId);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (toolsQuery.data ?? []).filter(
      (tool) =>
        !q ||
        tool.name.toLowerCase().includes(q) ||
        tool.providerName.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q),
    );
  }, [query, toolsQuery.data]);

  const isSearching = query.trim().length > 0;

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <section className="flex min-h-full flex-1 flex-col overflow-y-auto rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
        <div className="flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7">
          <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">
            Tools
          </h1>
          <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
            {filtered.length} items
          </span>
          <div className="flex-1" />
          <input
            type="search"
            aria-label="Search tools"
            placeholder="Search tools"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-[34px] w-[180px] rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
          />
        </div>

        <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7">
          {toolsQuery.isLoading && (
            <div className="py-10 text-[13px] text-text-3">Loading tools…</div>
          )}
          {toolsQuery.isError && (
            <div className="py-10 text-[13px] text-text-3">
              Could not load tools.
            </div>
          )}
          {!toolsQuery.isLoading &&
            !toolsQuery.isError &&
            filtered.length === 0 && (
              <div className="py-10 text-[13px] text-text-3">
                {isSearching ? (
                  <>No results for &ldquo;{query.trim()}&rdquo;.</>
                ) : (
                  <>No tools available.</>
                )}
              </div>
            )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
            {filtered.map((tool, i) => (
              <ToolCard
                key={tool.name}
                tool={tool}
                index={i + 1}
                onSelect={() =>
                  navigate(`/tools/${encodeURIComponent(tool.name)}`)
                }
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
