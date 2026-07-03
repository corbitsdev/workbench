import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Badge, PagePanel, Skeleton } from "@workbench/ui";
import { type Actor } from "@workbench/client";
import { useActor } from "../../hooks/use-actor";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { usePrincipalActivity } from "./ActorTimeline";
import { MomentWalker } from "./MomentWalker";
import { RecentActivity } from "./RecentActivity";
import { KIND_META } from "./timeline-kinds";

function KindBadge({ kind }: { kind: Actor["kind"] }) {
  return <Badge tone="identity">{kind === "user" ? "User" : "Agent"}</Badge>;
}

function isActorState(value: unknown): value is Actor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.kind === "user" || v.kind === "agent") &&
    typeof v.displayName === "string" &&
    typeof v.status === "string"
  );
}

function ActorName({
  actor,
  isLoading,
}: {
  actor: Actor | null;
  isLoading: boolean;
}) {
  if (actor) {
    return (
      <h1 className="text-[20px] font-semibold text-text">
        {actor.displayName}
      </h1>
    );
  }
  if (isLoading) return <Skeleton className="h-6 w-40" />;
  return <h1 className="text-[20px] font-semibold text-text">Unknown actor</h1>;
}

function lastActiveLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Subtle one-line stat strip — plain-language facts, never big KPI cards. */
function StatStrip({ items }: { items: { label: string; value: string }[] }) {
  return (
    <dl
      data-testid="trace-stat-strip"
      className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px]"
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
            {item.label}
          </dt>
          <dd className="font-mono tabular-nums text-text-2">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Facet = "overview" | "activity";

const FACETS: { value: Facet; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
];

function FacetTabs({
  facet,
  onFacet,
}: {
  facet: Facet;
  onFacet: (facet: Facet) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Trace facets"
      className="flex items-center gap-1 border-b border-border"
    >
      {FACETS.map((f) => {
        const active = facet === f.value;
        return (
          <button
            key={f.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onFacet(f.value)}
            className={`-mb-px min-h-[40px] border-b-2 px-3 py-1.5 text-[13px] font-medium outline-none transition-[colors,transform] focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] ${
              active
                ? "border-blue text-text"
                : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Principal trace shape (`/insights/users/:id`, id = principal id) — a roster +
 * rollup of what one human or agent principal owns and did. Deep-linkable:
 * identity resolves from the id via {@link useActor}; a passed router-state
 * actor renders instantly (only when its id matches) while the fetch confirms.
 * Facet tabs frame the two views; the Activity facet is the moment-walker over
 * the real timeline union. Every stat is derived from loaded data — nothing
 * not computable client-side is faked.
 */
export function ActorDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { activeTenantId, activeWorkbench, loading } = useActiveWorkbench();
  const [facet, setFacet] = useState<Facet>("overview");

  const principalId = id ?? "";
  // Only trust router-state identity when it is FOR this principal. The state is
  // caller-supplied (a spoofable navigation payload), so a mismatched id must
  // be ignored and the identity fetched by id instead.
  const stateActor =
    isActorState(location.state) && location.state.id === principalId
      ? location.state
      : null;

  const actorQuery = useActor(activeTenantId ?? "", principalId, stateActor);

  const activityQuery = usePrincipalActivity(
    activeTenantId ?? "",
    principalId,
    {
      enabled: !!activeTenantId && principalId !== "",
    },
  );
  const entries = activityQuery.data?.pages.flatMap((p) => p.entries) ?? [];
  const lastActive = entries[0]?.timestamp ?? null;
  const distinctKinds = new Set(entries.map((e) => e.kind));

  const actor = actorQuery.data ?? stateActor;

  const backLink = (
    <Link
      to="/insights"
      className="inline-flex min-h-[40px] items-center gap-1 rounded-[8px] px-2 py-1.5 text-[12px] font-medium text-text-3 outline-none transition-[colors,transform] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Insights
    </Link>
  );

  if (!loading && !activeTenantId) {
    return (
      <PagePanel scroll flat>
        <div className="px-5 py-5">
          {backLink}
          <div className="mt-4 rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
            Select a workbench to view this actor.
          </div>
        </div>
      </PagePanel>
    );
  }

  const statItems = [
    {
      label: "Moments loaded",
      value: activityQuery.isSuccess ? entries.length.toLocaleString() : "—",
    },
    {
      label: "Last active",
      value: lastActive ? lastActiveLabel(lastActive) : "—",
    },
    {
      label: "Kinds seen",
      value: activityQuery.isSuccess ? String(distinctKinds.size) : "—",
    },
  ];

  return (
    <PagePanel scroll flat>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-5 max-md:px-3">
        <div>{backLink}</div>

        <header className="flex flex-col gap-4 rounded-[16px] border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <ActorName actor={actor} isLoading={actorQuery.isLoading} />
            {actor && <KindBadge kind={actor.kind} />}
            {actor && actor.status !== "active" && (
              <Badge tone="neutral" data-testid="actor-status">
                {actor.status}
              </Badge>
            )}
          </div>

          <div className="flex flex-col gap-1 text-[12px]">
            {actor?.email && <span className="text-text-2">{actor.email}</span>}
            <span className="flex items-baseline gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-3">
                Principal ID
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-text-3">
                {principalId}
              </span>
            </span>
          </div>

          {actorQuery.isError && !actor && (
            <p className="text-[12px] text-text-3">
              This actor&rsquo;s identity couldn&rsquo;t be loaded, but their
              recorded activity is shown below.
            </p>
          )}

          <StatStrip items={statItems} />
        </header>

        <FacetTabs facet={facet} onFacet={setFacet} />

        {activeTenantId && principalId !== "" && (
          <section className="flex flex-col gap-3">
            {facet === "overview" && (
              <>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
                  What this {actor?.kind === "agent" ? "agent" : "actor"} owns
                  and did
                </h2>
                {activeWorkbench && (
                  <RecentActivity
                    tenantId={activeTenantId}
                    principalId={principalId}
                  />
                )}
              </>
            )}
            {facet === "activity" && (
              <>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
                  Moment-by-moment
                </h2>
                <MomentWalker
                  tenantId={activeTenantId}
                  principalId={principalId}
                />
              </>
            )}
          </section>
        )}

        <p className="sr-only">
          {`Kinds recorded: ${[...distinctKinds]
            .map((k) => KIND_META[k].label)
            .join(", ")}`}
        </p>
      </div>
    </PagePanel>
  );
}
