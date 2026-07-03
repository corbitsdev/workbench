import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import { Badge } from "@workbench/ui";
import { searchActors, type Actor } from "@workbench/client";
import { useDebouncedValue } from "../../hooks/use-debounced-value";

export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_QUERY_LENGTH = 2;
// Search results go stale fast (people/agents join and change status), so
// this is deliberately much shorter than the dashboard's 5-minute policy.
const SEARCH_STALE_MS = 30_000;

/** Deep link to an actor's routed detail page (`/insights/users/:id`). */
export function actorHref(actorId: string): string {
  return `/insights/users/${encodeURIComponent(actorId)}`;
}

function KindTag({ kind }: { kind: Actor["kind"] }) {
  return <Badge tone="identity">{kind === "user" ? "User" : "Agent"}</Badge>;
}

function StatusChip({ status }: { status: string }) {
  if (status === "active") return null;
  return (
    <Badge tone="neutral" data-testid="actor-status">
      {status}
    </Badge>
  );
}

function ActorRow({ actor, onSelect }: { actor: Actor; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left outline-none transition-colors hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-text">
          {actor.displayName}
        </span>
        {actor.email && (
          <span className="block truncate text-[11px] text-text-3">
            {actor.email}
          </span>
        )}
      </span>
      <StatusChip status={actor.status} />
      <KindTag kind={actor.kind} />
    </button>
  );
}

/**
 * Actor search surface for the Insights page. Selecting a result navigates to
 * that actor's routed detail page (`/insights/users/:id`), passing the loaded
 * {@link Actor} as router state so identity renders instantly while the detail
 * page confirms it from the id. Owns its own short-stale query lifecycle,
 * independent of the dashboard's 5-minute overview query.
 */
export function ActorActivitySection({ tenantId }: { tenantId: string }) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();

  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchEnabled = debouncedQuery.length >= SEARCH_MIN_QUERY_LENGTH;

  const searchQuery = useQuery({
    queryKey: ["actor-search", tenantId, debouncedQuery],
    queryFn: ({ signal }) =>
      searchActors({ init: { signal } }, { tenantId, query: debouncedQuery }),
    enabled: searchEnabled,
    staleTime: SEARCH_STALE_MS,
    placeholderData: keepPreviousData,
  });

  const actors = searchQuery.data ?? [];
  const trimmed = query.trim();

  function openActor(actor: Actor) {
    void navigate(actorHref(actor.id), { state: actor });
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
        People &amp; agents
      </h2>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-border bg-surface px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
          <Search size={16} className="flex-none text-text-3" />
          <input
            type="text"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search people and agents…"
            aria-label="Search people and agents"
            className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-3"
          />
        </div>

        {trimmed.length > 0 && trimmed.length < SEARCH_MIN_QUERY_LENGTH && (
          <p className="px-1 text-[12px] text-text-3">
            Type at least {SEARCH_MIN_QUERY_LENGTH} characters to search.
          </p>
        )}

        {searchEnabled && searchQuery.isPending && (
          <p className="px-1 text-[12px] text-text-3">Searching…</p>
        )}

        {searchQuery.isError && (
          <p className="px-1 text-[12px] text-text-3">
            Search failed. Please try again.
          </p>
        )}

        {searchEnabled && searchQuery.isSuccess && actors.length === 0 && (
          <p className="px-1 text-[12px] text-text-3">
            No people or agents match “{debouncedQuery}”.
          </p>
        )}

        {searchEnabled && actors.length > 0 && (
          <ul className="flex flex-col rounded-[12px] border border-border bg-surface p-1">
            {actors.map((actor) => (
              <li key={actor.id}>
                <ActorRow actor={actor} onSelect={() => openActor(actor)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
