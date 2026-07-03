import { Info } from "lucide-react";
import { Badge } from "@workbench/ui";
import type { TimelineEntry } from "@workbench/client";
import {
  FacetCard,
  FacetDesc,
  GapBanner,
  NodeGrid,
  type TraceNode,
} from "./tracer-shell";
import { humanizeToken } from "./activity-naming";
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

export function GrantsFacet({ entries }: { entries: TimelineEntry[] }) {
  const grants = entries
    .filter((e) => e.kind === "grant")
    .map(toGrantRow)
    // De-dup a permission that appears more than once in the loaded window.
    .filter(
      (g, i, all) => all.findIndex((o) => o.resource === g.resource) === i,
    );

  return (
    <div data-testid="facet-grants">
      <FacetDesc>
        Permissions this principal holds, in plain language — the raw resource
        id stays as a secondary reference. Whether each was actually exercised
        is the gap.
      </FacetDesc>
      <GapBanner ticket="CL-2722">
        Interchange computes which grant authorized each action but does not
        persist it yet, so a &ldquo;used&rdquo; count cannot be shown here
        without fabricating it.
      </GapBanner>
      {grants.length === 0 ? (
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
                  <Th>Do what</Th>
                  <Th>Decision</Th>
                  <Th>Granted by</Th>
                  <Th>Used</Th>
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr
                    key={g.id}
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
                    <Td>
                      <span
                        data-testid="grant-used-gap"
                        className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-cream-deep bg-cream/40 px-1.5 py-0.5 font-mono text-[10px] text-gold"
                      >
                        <Info className="h-2.5 w-2.5" />
                        not recorded
                      </span>
                    </Td>
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

export interface ToolRow {
  name: string;
  plain: string;
  calls: number;
}

/** Aggregates `tool_call` timeline entries into per-tool call counts. */
export function toolRowsFromEntries(entries: TimelineEntry[]): ToolRow[] {
  const byName = new Map<string, ToolRow>();
  for (const e of entries) {
    if (e.kind !== "tool_call") continue;
    const name = (e.summary ?? "").trim() || "Unknown tool";
    const existing = byName.get(name);
    if (existing !== undefined) existing.calls += 1;
    else byName.set(name, { name, plain: humanizeToken(name), calls: 1 });
  }
  return [...byName.values()].sort((a, b) => b.calls - a.calls);
}

export function ToolsFacet({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ToolsFacetView
      tools={toolRowsFromEntries(entries)}
      description="Every tool invoked in the loaded window and how often. The concrete data each call touched is the gap."
      emptyText="No tool calls in the loaded window."
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
      <GapBanner ticket="CL-2724">
        We record that a tool ran — not its inputs, its output, or <b>which</b>{" "}
        records it touched.
      </GapBanner>
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
                    <Td>
                      <span className="inline-flex items-center gap-1 rounded-[5px] border border-dashed border-cream-deep bg-cream/40 px-1.5 py-0.5 font-mono text-[10px] text-gold">
                        <Info className="h-2.5 w-2.5" />
                        which records?
                      </span>
                    </Td>
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

export function CostFacet({ label }: { label: string }) {
  return (
    <div data-testid="facet-cost">
      <FacetDesc>
        {label} keeps token classes separate — fresh input, cache read, cache
        write, output are never summed — then prices each independently.
      </FacetDesc>
      <GapBanner ticket="CL-2723">
        Token counts are recorded per model and per day, not attributed to this
        principal or moment; and the dollar layer isn&rsquo;t wired into
        analytics yet. Rather than show a fabricated total, this trace surfaces
        the gap.
      </GapBanner>
      <FacetCard title="Token classes → cost">
        <ul className="flex flex-col gap-2 text-[12.5px] text-text-2">
          {["Fresh input", "Cache read", "Cache write", "Output"].map((cls) => (
            <li key={cls} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-[3px] bg-blue" />
                {cls}
              </span>
              <span className="font-mono text-[11px] text-gold">
                not recorded yet
              </span>
            </li>
          ))}
        </ul>
      </FacetCard>
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
