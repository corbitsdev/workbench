import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { PagePanel } from "@workbench/ui";
import { type Actor } from "@workbench/client";
import { useActor } from "../../hooks/use-actor";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import { usePublishActiveContext } from "../../lib/active-context-store";
import { usePrincipalActivity } from "./ActorTimeline";
import { MomentWalker } from "./MomentWalker";
import {
  ConnectionsFacet,
  CostFacet,
  GrantsFacet,
  RosterFacet,
  ToolsFacet,
} from "./principal-facets";
import {
  CompactHeader,
  FacetTabs,
  StatStrip,
  type FacetDef,
  type Stat,
  type StatusPill,
  type TraceRoot,
  TracerFacetNav,
  traceFacetPanelId,
} from "./tracer-shell";
import { actorStatusTone } from "./status-tone";

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

function lastActiveLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Compact activity summary for the active-context projection (CL-2726). The
// projector truncates it to PRINCIPAL_SUMMARY_MAX_CHARS, so this only needs to
// be a faithful, readable digest of the loaded activity union — never the full
// record set. Counts every kind (including ones outside the named buckets) so
// the total and the breakdown never disagree.
const SUMMARY_KINDS = [
  ["tool_call", "tool calls"],
  ["grant", "grants"],
  ["workflow_run", "workflow runs"],
  ["artifact", "artifacts"],
] as const;

function buildPrincipalSummary(
  entries: { kind: string; timestamp?: string | null }[],
): string {
  const count = (kind: string) => entries.filter((e) => e.kind === kind).length;
  const named = SUMMARY_KINDS.reduce((sum, [k]) => sum + count(k), 0);
  const other = entries.length - named;
  const lines = [
    `${entries.length} recorded moments`,
    ...SUMMARY_KINDS.map(([kind, label]) => `${label}: ${count(kind)}`),
  ];
  if (other > 0) lines.push(`other: ${other}`);
  const last = entries[0]?.timestamp;
  if (last) lines.push(`last active: ${lastActiveLabel(last)}`);
  return lines.join("\n");
}

const FACETS: FacetDef[] = [
  { id: "timeline", label: "Timeline", hasGap: true },
  { id: "roster", label: "Agents & workflows", hasGap: false },
  { id: "grants", label: "Grants", hasGap: true },
  { id: "tools", label: "Tools", hasGap: true },
  { id: "cost", label: "Cost", hasGap: true },
  { id: "connections", label: "Connections", hasGap: false },
];

/**
 * Principal trace (`/insights/users/:id`, id = principal id), rebuilt to the
 * approved Tracer artifact: a Trace-root rail + legend, a compact identity
 * header, an underlined facet tab bar over a subtle stat strip, and a
 * Back / Next-step bottom nav. The Timeline facet is the moment-walker over the
 * real activity union; the Grants / Tools / Connections / Cost facets are
 * projected from that SAME loaded union, with honest "not recorded yet" banners
 * wherever the record model has no value — nothing is fabricated.
 */
export function ActorDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { activeTenantId, loading } = useActiveWorkbench();
  const [facetIndex, setFacetIndex] = useState(0);

  const principalId = id ?? "";
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

  const actor = actorQuery.data ?? stateActor;
  const backLink = "/insights";

  // Publish the viewed principal as the active surface (CL-2726) so the Myra
  // popup can attach it as context. Only once identity has actually resolved —
  // never publish a "Loading…" or "Unknown actor" placeholder.
  usePublishActiveContext(
    actor
      ? {
          kind: "principal",
          id: principalId,
          label: actor.displayName,
          actorKind: actor.kind,
          status: actor.status,
          summary: buildPrincipalSummary(entries),
        }
      : null,
    actor ? `${actor.id}:${entries.length}` : undefined,
  );

  if (!loading && !activeTenantId) {
    return (
      <PagePanel scroll flat>
        <div className="px-5 py-5">
          <Link
            to={backLink}
            className="text-[12px] font-medium text-text-3 hover:text-text"
          >
            ← Insights
          </Link>
          <div className="mt-4 rounded-[12px] border border-border bg-surface p-4 text-[13px] text-text-2">
            Select a workbench to view this actor.
          </div>
        </div>
      </PagePanel>
    );
  }

  // While the identity is still loading (and no trusted navigation payload
  // seeded it), show a neutral loading label rather than flashing the
  // "Unknown actor" fallback — that fallback is honest only once the lookup has
  // actually resolved without a name.
  const identityPending = actorQuery.isLoading && actor === null;
  let name = "Unknown actor";
  if (actor) name = actor.displayName;
  else if (identityPending) name = "Loading actor…";
  const kindChip = actor?.kind === "agent" ? "agent" : "principal";
  const root: TraceRoot = {
    kindChip,
    name,
    rawId: principalId,
    tone: "identity",
  };

  // No pill when identity is unknown (loading OR failed): never assert a live
  // "Active" state for a principal we haven't loaded.
  let status: StatusPill | null = null;
  if (actor) {
    status = {
      tone: actorStatusTone(actor.status),
      label: actor.status === "active" ? "Active" : actor.status,
    };
  }

  // The stat strip is derived from the activity union; until that query has
  // succeeded, show "—" rather than a fabricated 0 that reads as "no activity".
  const activityReady = activityQuery.isSuccess;
  const statValue = (n: number) => (activityReady ? n.toLocaleString() : "—");
  const count = (kind: string) => entries.filter((e) => e.kind === kind).length;
  const lastActive = entries[0]?.timestamp ?? null;
  const stats: Stat[] = [
    { label: "Moments", value: statValue(entries.length) },
    { label: "Tool calls", value: statValue(count("tool_call")) },
    { label: "Grants", value: statValue(count("grant")) },
    { label: "Runs", value: statValue(count("workflow_run")) },
    { label: "Artifacts", value: statValue(count("artifact")) },
    {
      label: "Last active",
      value: activityReady && lastActive ? lastActiveLabel(lastActive) : "—",
    },
  ];

  const activeFacet = FACETS[facetIndex]!.id;

  return (
    <PagePanel scroll flat>
      <div className="w-full px-6 py-5 max-md:px-3">
        <main className="min-w-0 flex-1">
          <CompactHeader root={root} status={status} backTo={backLink} />

          {actorQuery.isError && !actor && (
            <p className="mt-2 text-[12px] text-text-3">
              This actor&rsquo;s identity couldn&rsquo;t be loaded, but their
              recorded activity is shown below.
            </p>
          )}

          <div className="mt-3.5">
            <FacetTabs
              facets={FACETS}
              activeId={activeFacet}
              onSelect={(fid) =>
                setFacetIndex(FACETS.findIndex((f) => f.id === fid))
              }
            />
            <StatStrip stats={stats} />
          </div>

          <section className="mt-3">
            {activeTenantId && principalId !== "" ? (
              <>
                {activeFacet === "timeline" && (
                  <div
                    id={traceFacetPanelId("timeline")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-timeline"
                  >
                    <MomentWalker
                      tenantId={activeTenantId}
                      principalId={principalId}
                    />
                  </div>
                )}
                {activeFacet === "roster" && (
                  <div
                    id={traceFacetPanelId("roster")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-roster"
                  >
                    <RosterFacet
                      tenantId={activeTenantId}
                      principalId={principalId}
                    />
                  </div>
                )}
                {activeFacet === "grants" && (
                  <div
                    id={traceFacetPanelId("grants")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-grants"
                  >
                    <GrantsFacet entries={entries} />
                  </div>
                )}
                {activeFacet === "tools" && (
                  <div
                    id={traceFacetPanelId("tools")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-tools"
                  >
                    <ToolsFacet
                      tenantId={activeTenantId}
                      principalId={principalId}
                    />
                  </div>
                )}
                {activeFacet === "cost" && (
                  <div
                    id={traceFacetPanelId("cost")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-cost"
                  >
                    <CostFacet
                      tenantId={activeTenantId}
                      principalId={principalId}
                      label={name}
                    />
                  </div>
                )}
                {activeFacet === "connections" && (
                  <div
                    id={traceFacetPanelId("connections")}
                    role="tabpanel"
                    aria-labelledby="trace-facet-tab-connections"
                  >
                    <ConnectionsFacet entries={entries} />
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-[12px] border border-border bg-surface p-8 text-center text-[13px] text-text-2">
                No trace to show.
              </div>
            )}
          </section>

          <TracerFacetNav
            backTo={backLink}
            facets={FACETS}
            activeIndex={facetIndex}
            onFacetIndexChange={setFacetIndex}
          />
        </main>
      </div>
    </PagePanel>
  );
}
