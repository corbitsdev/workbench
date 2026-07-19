import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Skeleton } from "@workbench/ui";
import type { TimelineEntry } from "@workbench/client";
import { usePrincipalRoster } from "../../hooks/use-principal-roster";
import { usePrincipalAnalytics } from "../../hooks/use-principal-analytics";
import {
  FacetCard,
  FacetDesc,
  GapBanner,
  NodeGrid,
  type TraceNode,
} from "./tracer-shell";
import { humanizeToken, parseToolResource } from "./activity-naming";
import {
  GRANT_EFFECT_LABEL,
  entityLinkForEntry,
  grantEffect,
  grantOrigin,
  grantResourceLabel,
  type GrantEffect,
} from "./trace-links";

/**
 * The non-timeline facets of the principal trace, all derived from the SAME
 * loaded timeline union — no separate fabricated queries. Grant rows, tool
 * calls, and linkable entities are projected out of the real entries; the
 * values the record model does not carry (grant usage, tool I/O, per-principal
 * token cost) are shown as explicit honest-gap banners, never invented.
 */

interface GrantRow {
  id: string;
  resource: string;
  plain: string;
  action: string;
  origin: string | null;
  effect: GrantEffect;
}

/**
 * Projects a grant timeline entry to a row using the CANONICAL parsers from
 * trace-links (grantEffect / grantOrigin / grantResourceLabel) — the same
 * source of truth the moment decomposition reads, so the two surfaces can never
 * report a different effect for the same row.
 */
function toGrantRow(entry: TimelineEntry): GrantRow {
  const resource =
    (entry.summary ?? "").trim().split(/\s+/).filter(Boolean)[0] ?? "";
  const action =
    (entry.summary ?? "").trim().split(/\s+/).filter(Boolean)[1] ?? "";
  return {
    id: entry.id,
    resource,
    plain: resource === "" ? "Permission" : grantResourceLabel(resource),
    action: action === "" ? "—" : humanizeToken(action),
    origin: grantOrigin(entry),
    effect: grantEffect(entry),
  };
}

function effectTone(
  effect: GrantRow["effect"],
): "positive" | "danger" | "neutral" {
  if (effect === "allowed") return "positive";
  if (effect === "blocked") return "danger";
  return "neutral";
}

/**
 * Resource family key for grouping (CL-3919). A raw grant list can carry
 * 100+ rows for a single busy agent instance — one per distinct tool call it
 * was ever granted — so we group by the resource's family before rendering:
 * for a `tool:` resource that is the factory/package segment (parsed via the
 * canonical `parseToolResource`, the SAME parser `grantResourceLabel` already
 * reads through); for any other resource kind (`instance:`, `requirement:`,
 * …) it is the prefix before the first `:`.
 */
function grantFamilyKey(resource: string): { key: string; label: string } {
  const tool = parseToolResource(resource);
  if (tool !== null) {
    return { key: `tool:${tool.factory}`, label: humanizeToken(tool.factory) };
  }
  const prefix = resource.split(":")[0] ?? "";
  const safePrefix = prefix === "" ? "other" : prefix;
  return { key: safePrefix, label: humanizeToken(safePrefix) };
}

interface GrantGroup {
  key: string;
  label: string;
  rows: GrantRow[];
}

function groupGrantRows(rows: GrantRow[]): GrantGroup[] {
  const groups: GrantGroup[] = [];
  const index = new Map<string, GrantGroup>();
  for (const row of rows) {
    const { key, label } = grantFamilyKey(row.resource);
    let group = index.get(key);
    if (group === undefined) {
      group = { key, label, rows: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

export function GrantsFacet({ entries }: { entries: TimelineEntry[] }) {
  const grants = entries
    .filter((e) => e.kind === "grant")
    .map(toGrantRow)
    // De-dup a permission that appears more than once in the loaded window.
    .filter(
      (g, i, all) => all.findIndex((o) => o.resource === g.resource) === i,
    );
  const groups = groupGrantRows(grants);

  return (
    <div data-testid="facet-grants">
      <FacetDesc>
        Permissions this principal holds, grouped by resource family — the raw
        resource id stays as a secondary reference. Expand a group to see its
        individual rules.
      </FacetDesc>
      {groups.length === 0 ? (
        <FacetCard>
          <p className="text-[13px] text-text-2">
            No grant moments in the loaded window.
          </p>
        </FacetCard>
      ) : (
        <FacetCard>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th>Can</Th>
                  <Th>Rules</Th>
                  <Th>Decision</Th>
                  <Th>Granted by</Th>
                  <Th>Used</Th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <GrantGroupRow key={group.key} group={group} />
                ))}
              </tbody>
            </table>
          </div>
        </FacetCard>
      )}
    </div>
  );
}

/**
 * One collapsed group row per resource family, with its own local expand
 * state (default collapsed — CL-3919). A deny rule anywhere in the group is
 * NEVER folded away inside an "allowed" summary: it always surfaces its own
 * visible marker on the row, and deny rules sort first once expanded.
 */
function GrantGroupRow({ group }: { group: GrantGroup }) {
  const [expanded, setExpanded] = useState(false);

  const allowCount = group.rows.filter((r) => r.effect === "allowed").length;
  const denyCount = group.rows.filter((r) => r.effect === "blocked").length;
  const askCount = group.rows.filter(
    (r) => r.effect === "needs-approval",
  ).length;
  const unknownCount = group.rows.filter((r) => r.effect === "unknown").length;
  const hasDeny = denyCount > 0;

  const origins = [
    ...new Set(
      group.rows.map((r) => r.origin).filter((o): o is string => o !== null),
    ),
  ];

  const orderedRows = hasDeny
    ? [...group.rows].sort((a, b) => {
        const aDeny = a.effect === "blocked" ? 0 : 1;
        const bDeny = b.effect === "blocked" ? 0 : 1;
        return aDeny - bDeny;
      })
    : group.rows;

  return (
    <>
      <tr
        className="border-b border-border last:border-0"
        data-testid="grant-group-row"
      >
        <Td>
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex items-center gap-1.5 font-semibold text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <ChevronRight
              className={`h-3.5 w-3.5 shrink-0 text-text-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            {group.label}
          </button>
        </Td>
        <Td className="text-text-2">
          {group.rows.length} {group.rows.length === 1 ? "rule" : "rules"}
        </Td>
        <Td>
          <div className="flex flex-wrap items-center gap-1.5">
            {allowCount > 0 && (
              <Badge tone="positive">{allowCount} allowed</Badge>
            )}
            {hasDeny && (
              <Badge tone="danger" data-testid="grant-group-deny-marker">
                {denyCount} denied
              </Badge>
            )}
            {askCount > 0 && (
              <Badge tone="neutral">{askCount} needs approval</Badge>
            )}
            {unknownCount > 0 && (
              <Badge tone="neutral">{unknownCount} unrecorded</Badge>
            )}
          </div>
        </Td>
        <Td>
          {origins.length === 0 ? (
            <span className="text-text-3">—</span>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              {origins.map((origin) => (
                <span
                  key={origin}
                  data-testid="grant-group-origin"
                  className="inline-flex items-center rounded-[5px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-2"
                >
                  {origin}
                </span>
              ))}
            </div>
          )}
        </Td>
        <Td className="text-text-3">—</Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="p-0">
            <div className="overflow-x-auto border-t border-border bg-surface-2/40 px-3 py-2">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <Th>Can</Th>
                    <Th>Do what</Th>
                    <Th>Decision</Th>
                    <Th>Granted by</Th>
                    <Th>Used</Th>
                  </tr>
                </thead>
                <tbody>
                  {orderedRows.map((g) => (
                    <tr
                      key={g.id}
                      data-testid="grant-rule-row"
                      className="border-b border-border last:border-0"
                    >
                      <Td>
                        <div className="font-semibold text-text">{g.plain}</div>
                        <div className="break-all font-mono text-[10px] text-text-3">
                          {g.resource}
                        </div>
                      </Td>
                      <Td className="text-text-2">{g.action}</Td>
                      <Td>
                        <Badge tone={effectTone(g.effect)}>
                          {GRANT_EFFECT_LABEL[g.effect]}
                        </Badge>
                      </Td>
                      <Td>
                        {g.origin !== null ? (
                          <span
                            data-testid="grant-origin"
                            className="inline-flex items-center rounded-[5px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-2"
                          >
                            {g.origin}
                          </span>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </Td>
                      <Td className="text-text-3">—</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export interface ToolRow {
  name: string;
  plain: string;
  calls: number;
}

/**
 * Tools facet. Aggregates the principal's tool calls from the durable
 * analytics_event facts — the agent's FULL recorded history — instead of
 * counting only the loaded timeline window (which under-counted, showing 0 when
 * tools were older than the first page).
 */
export function ToolsFacet({
  tenantId,
  principalId,
}: {
  tenantId: string;
  principalId: string;
}) {
  const query = usePrincipalAnalytics(tenantId, principalId, {
    enabled: tenantId !== "" && principalId !== "",
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2" data-testid="tools-loading">
        <Skeleton className="h-16 w-full rounded-[10px]" />
        <Skeleton className="h-16 w-full rounded-[10px]" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <FacetCard>
        <div
          className="flex flex-col items-start gap-2"
          data-testid="facet-tools"
        >
          <p className="text-[13px] text-text-2">
            Couldn&rsquo;t load this principal&rsquo;s tool activity. Please try
            again.
          </p>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
          >
            Retry
          </button>
        </div>
      </FacetCard>
    );
  }

  const tools: ToolRow[] = (query.data?.tools ?? []).map((t) => ({
    name: t.name,
    plain: humanizeToken(t.name),
    calls: t.calls,
  }));

  return (
    <ToolsFacetView
      tools={tools}
      description="Every tool this agent has invoked and how often, across its full recorded history."
      emptyText="No tool calls recorded for this principal."
    />
  );
}

/**
 * Presentational tools table, shared by the principal trace (aggregating
 * `tool_call` entries) and the execution trace (aggregating a run's tool
 * steps). Same CL-2724 gap: we record that a tool ran, not what it touched.
 */
export function ToolsFacetView({
  tools,
  description,
  emptyText,
}: {
  tools: ToolRow[];
  description: string;
  emptyText: string;
}) {
  const max = tools.reduce((m, t) => Math.max(m, t.calls), 1);

  return (
    <div data-testid="facet-tools">
      <FacetDesc>{description}</FacetDesc>
      {tools.length === 0 ? (
        <FacetCard>
          <p className="text-[13px] text-text-2">{emptyText}</p>
        </FacetCard>
      ) : (
        <FacetCard>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <Th>Tool</Th>
                  <Th>Calls</Th>
                  <Th>Share</Th>
                  <Th>Data touched</Th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr
                    key={t.name}
                    className="border-b border-border last:border-0"
                  >
                    <Td>
                      <div className="font-semibold text-text">{t.plain}</div>
                      <div className="break-all font-mono text-[10px] text-text-3">
                        {t.name}
                      </div>
                    </Td>
                    <Td className="font-mono tabular-nums text-text-2">
                      {t.calls}
                    </Td>
                    <Td>
                      <span className="block h-2 w-full max-w-[160px] overflow-hidden rounded-full bg-surface-2">
                        <span
                          className="block h-full rounded-full bg-blue"
                          style={{
                            width: `${Math.round((t.calls / max) * 100)}%`,
                          }}
                        />
                      </span>
                    </Td>
                    <Td className="text-text-3">—</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </FacetCard>
      )}
    </div>
  );
}

export function ConnectionsFacet({ entries }: { entries: TimelineEntry[] }) {
  const seen = new Set<string>();
  const nodes: TraceNode[] = [];
  for (const e of entries) {
    const link = entityLinkForEntry(e);
    if (link === null) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    nodes.push({
      kind: e.kind === "workflow_run" ? "workflow run" : "artifact",
      label: e.summary ?? link.label,
      rawId: e.id,
      meta: e.kind === "workflow_run" ? "started here" : "authored here",
      to: link.to,
    });
  }

  return (
    <div data-testid="facet-connections">
      <FacetDesc>
        Entities this principal produced or touched that have their own trace.
        Open one to trace it.
      </FacetDesc>
      {nodes.length === 0 ? (
        <FacetCard>
          <p className="text-[13px] text-text-2">
            No linkable entities (workflow runs or artifacts) in the loaded
            window. Sessions, messages, and grants have no dedicated trace page
            yet, so they are not shown here rather than shown as dead links.
          </p>
        </FacetCard>
      ) : (
        <NodeGrid nodes={nodes} />
      )}
    </div>
  );
}

/**
 * The "Agents & workflows" roster (CL-2737): the agent instances this principal
 * owns and the workflow runs it started, each a clickable card that opens THAT
 * entity's own trace — an agent instance links to its synthetic principal's
 * trace (`/insights/users/:principalId`, the same ActorDetailPage surface), a
 * run links to its execution trace (`/insights/trace/:runId`). This answers
 * "why is it principal only / why can't I click on an agent or a run" — from a
 * principal you can now open any owned agent or run and trace it.
 */
export function RosterFacet({
  tenantId,
  principalId,
}: {
  tenantId: string;
  principalId: string;
}) {
  const query = usePrincipalRoster(tenantId, principalId, {
    enabled: tenantId !== "" && principalId !== "",
  });

  const instanceNodes: TraceNode[] = (query.data?.instances ?? []).map((i) => ({
    kind: "agent instance",
    label: i.name,
    rawId: i.principalId,
    meta:
      i.sessionCount === 1
        ? `${i.status} · 1 session`
        : `${i.status} · ${i.sessionCount} sessions`,
    to: `/insights/users/${encodeURIComponent(i.principalId)}`,
  }));

  const runNodes: TraceNode[] = (query.data?.runs ?? []).map((r) => ({
    kind: "workflow run",
    label: r.kind,
    rawId: r.runId,
    meta: r.status,
    to: `/insights/trace/${encodeURIComponent(r.runId)}`,
  }));

  return (
    <div data-testid="facet-roster">
      <FacetDesc>
        Every agent this principal owns and every workflow run it started. Open
        one to trace it.
      </FacetDesc>

      {query.isLoading && (
        <div className="flex flex-col gap-2" data-testid="roster-loading">
          <Skeleton className="h-16 w-full rounded-[10px]" />
          <Skeleton className="h-16 w-full rounded-[10px]" />
        </div>
      )}

      {query.isError && (
        <FacetCard>
          <div className="flex flex-col items-start gap-2">
            <p className="text-[13px] text-text-2">
              Couldn&rsquo;t load this principal&rsquo;s agents and runs. Please
              try again.
            </p>
            <button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
              className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
            >
              Retry
            </button>
          </div>
        </FacetCard>
      )}

      {query.isSuccess && (
        <div className="flex flex-col gap-4">
          <RosterGroup
            title="Agent instances"
            nodes={instanceNodes}
            emptyText="This principal owns no agent instances."
          />
          <RosterGroup
            title="Workflow runs"
            nodes={runNodes}
            emptyText="This principal has started no workflow runs."
          />
        </div>
      )}
    </div>
  );
}

function RosterGroup({
  title,
  nodes,
  emptyText,
}: {
  title: string;
  nodes: TraceNode[];
  emptyText: string;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-3">
        {title}
      </h3>
      {nodes.length === 0 ? (
        <FacetCard>
          <p className="text-[13px] text-text-2">{emptyText}</p>
        </FacetCard>
      ) : (
        <NodeGrid nodes={nodes} />
      )}
    </section>
  );
}

/**
 * Cost facet. Renders the principal's token-class totals from the
 * durable analytics_event facts, keyed on the principal attribution set. Was a
 * static "not recorded yet" stub; the per-principal token grain has always been
 * recorded — it just was never queried. Dollar pricing is a separate layer
 * (surfaced in the tenant cost dashboard), so this shows token counts, not a
 * fabricated dollar total.
 */
export function CostFacet({
  tenantId,
  principalId,
  label,
}: {
  tenantId: string;
  principalId: string;
  label: string;
}) {
  const query = usePrincipalAnalytics(tenantId, principalId, {
    enabled: tenantId !== "" && principalId !== "",
  });

  const cost = query.data?.cost;
  const classes: { label: string; value: number }[] = [
    { label: "Fresh input", value: cost?.inputTokens ?? 0 },
    { label: "Cache read", value: cost?.cacheReadTokens ?? 0 },
    { label: "Cache write", value: cost?.cacheWriteTokens ?? 0 },
    { label: "Output", value: cost?.outputTokens ?? 0 },
    ...(cost && cost.thinkingTokens > 0
      ? [{ label: "Thinking", value: cost.thinkingTokens }]
      : []),
  ];
  const hasUsage =
    cost !== undefined &&
    (cost.inputTokens > 0 ||
      cost.outputTokens > 0 ||
      cost.cacheReadTokens > 0 ||
      cost.cacheWriteTokens > 0 ||
      cost.thinkingTokens > 0);

  return (
    <div data-testid="facet-cost">
      <FacetDesc>
        {label} keeps token classes separate — fresh input, cache read, cache
        write, output are never summed. Counts are the principal&rsquo;s full
        recorded inference history; dollar pricing is applied separately.
      </FacetDesc>

      {query.isLoading && (
        <div className="flex flex-col gap-2" data-testid="cost-loading">
          <Skeleton className="h-24 w-full rounded-[10px]" />
        </div>
      )}

      {query.isError && (
        <FacetCard>
          <div className="flex flex-col items-start gap-2">
            <p className="text-[13px] text-text-2">
              Couldn&rsquo;t load this principal&rsquo;s cost. Please try again.
            </p>
            <button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
              className="flex min-h-[40px] items-center rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
            >
              Retry
            </button>
          </div>
        </FacetCard>
      )}

      {query.isSuccess && !hasUsage && (
        <FacetCard>
          <p className="text-[13px] text-text-2">
            No token usage recorded for this principal yet.
          </p>
        </FacetCard>
      )}

      {query.isSuccess && hasUsage && (
        <FacetCard title="Token classes">
          <ul className="flex flex-col gap-2 text-[12.5px] text-text-2">
            {classes.map((cls) => (
              <li
                key={cls.label}
                className="flex items-center justify-between gap-3"
              >
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-[3px] bg-blue" />
                  {cls.label}
                </span>
                <span className="font-mono tabular-nums text-[11px] text-text">
                  {cls.value.toLocaleString()}
                </span>
              </li>
            ))}
            <li className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-2 text-text-3">
              <span>Inference calls</span>
              <span className="font-mono tabular-nums text-[11px]">
                {(cost?.inferenceCalls ?? 0).toLocaleString()}
              </span>
            </li>
          </ul>
        </FacetCard>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-border pb-2 pr-3 text-left font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-text-3">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`py-2.5 pr-3 align-middle ${className ?? ""}`}>
      {children}
    </td>
  );
}
