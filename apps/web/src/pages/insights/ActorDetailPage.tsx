import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Badge, PagePanel, Skeleton } from "@workbench/ui";
import { getActor, type Actor } from "@workbench/client";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { ActorTimeline, usePrincipalActivity } from "./ActorTimeline";

const ACTOR_STALE_MS = 5 * 60_000;

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

function QuickStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[12px] border border-border bg-surface px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-3">
        {label}
      </span>
      <span className="font-mono text-[15px] tabular-nums text-text">
        {value}
      </span>
    </div>
  );
}

function lastActiveLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Routed actor detail page (`/insights/users/:id`, id = principal id).
 * Deep-linkable: identity is resolved from the id via {@link getActor}; when
 * navigated internally, the passed router-state actor renders instantly while
 * the fetch confirms. Quick stats are derived only from loaded activity —
 * anything not computable client-side is omitted rather than faked.
 */
export function ActorDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { activeTenantId, loading } = useActiveWorkbench();

  const principalId = id ?? "";
  // Only trust router-state identity when it is FOR this principal. The state is
  // caller-supplied (a spoofable navigation payload), so a mismatched id must
  // be ignored and the identity fetched by id instead.
  const stateActor =
    isActorState(location.state) && location.state.id === principalId
      ? location.state
      : null;

  const actorQuery = useQuery({
    queryKey: ["actor", activeTenantId, principalId],
    queryFn: ({ signal }) =>
      getActor(
        { init: { signal } },
        { tenantId: activeTenantId!, principalId },
      ),
    enabled: !!activeTenantId && principalId !== "",
    staleTime: ACTOR_STALE_MS,
    ...(stateActor ? { placeholderData: stateActor } : {}),
  });

  const activityQuery = usePrincipalActivity(
    activeTenantId ?? "",
    principalId,
    {
      enabled: !!activeTenantId && principalId !== "",
    },
  );
  const entries = activityQuery.data?.pages.flatMap((p) => p.entries) ?? [];
  const lastActive = entries[0]?.timestamp ?? null;

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
            <span className="font-mono text-[11px] tabular-nums text-text-3">
              {principalId}
            </span>
          </div>

          {actorQuery.isError && !actor && (
            <p className="text-[12px] text-text-3">
              This actor's identity couldn't be loaded, but their recorded
              activity is shown below.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <QuickStat
              label="Entries loaded"
              value={
                activityQuery.isSuccess ? entries.length.toLocaleString() : "—"
              }
            />
            <QuickStat
              label="Last active"
              value={lastActive ? lastActiveLabel(lastActive) : "—"}
            />
          </div>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">
            Activity timeline
          </h2>
          {activeTenantId && principalId !== "" && (
            <ActorTimeline
              tenantId={activeTenantId}
              principalId={principalId}
            />
          )}
        </section>
      </div>
    </PagePanel>
  );
}
