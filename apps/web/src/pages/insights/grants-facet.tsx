import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@workbench/ui";
import type { TimelineEntry } from "@workbench/client";
import { FacetCard, FacetDesc } from "./tracer-shell";
import { humanizeToken, parseToolResource } from "./activity-naming";
import {
  GRANT_EFFECT_LABEL,
  grantEffect,
  grantOrigin,
  grantResourceLabel,
  type GrantEffect,
} from "./trace-links";

/**
 * The Grants facet of the principal trace (CL-3919), split out of
 * principal-facets.tsx to keep that file from growing past its already-
 * flagged size. Split off with its own tests in grants-facet.test.tsx.
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

interface GrantGroup {
  key: string;
  label: string;
  rows: GrantRow[];
}

type GrantDisplayItem =
  | { kind: "row"; row: GrantRow }
  | { kind: "group"; group: GrantGroup };

/**
 * A raw grant list can carry 100+ rows for a single busy agent instance — one
 * per distinct tool call it was ever granted. Only `tool:` resources get
 * grouped (grouping any other resource kind on a bare prefix, e.g.
 * `credential:`, collapses distinct credentials/instances/requirements into
 * one row and hides exactly which one an operator needs to see) and only
 * when the family has 2+ rules — a lone rule renders as a plain,
 * non-collapsible row identical to the ungrouped presentation, so a single
 * grant never gains an extra click to reveal itself. Order is preserved from
 * the input so grouping never reshuffles the list.
 */
function buildGrantDisplayItems(rows: GrantRow[]): GrantDisplayItem[] {
  const groupsByFactory = new Map<string, GrantGroup>();
  for (const row of rows) {
    const tool = parseToolResource(row.resource);
    if (tool === null) continue;
    const key = `tool:${tool.factory}`;
    let group = groupsByFactory.get(key);
    if (group === undefined) {
      // Empty-suffix guard: a resource literally "tool:" parses to an empty
      // factory, which would otherwise produce an empty group label.
      const label =
        tool.factory.trim() === "" ? row.resource : humanizeToken(tool.factory);
      group = { key, label, rows: [] };
      groupsByFactory.set(key, group);
    }
    group.rows.push(row);
  }

  const items: GrantDisplayItem[] = [];
  const emittedGroupKeys = new Set<string>();
  for (const row of rows) {
    const tool = parseToolResource(row.resource);
    if (tool === null) {
      items.push({ kind: "row", row });
      continue;
    }
    const key = `tool:${tool.factory}`;
    const group = groupsByFactory.get(key);
    if (group === undefined || group.rows.length === 1) {
      items.push({ kind: "row", row });
      continue;
    }
    if (emittedGroupKeys.has(key)) continue;
    emittedGroupKeys.add(key);
    items.push({ kind: "group", group });
  }
  return items;
}

export function GrantsFacet({ entries }: { entries: TimelineEntry[] }) {
  const grants = entries
    .filter((e) => e.kind === "grant")
    .map(toGrantRow)
    // De-dup a permission that appears more than once in the loaded window.
    .filter(
      (g, i, all) => all.findIndex((o) => o.resource === g.resource) === i,
    );
  const items = buildGrantDisplayItems(grants);

  return (
    <div data-testid="facet-grants">
      <FacetDesc>
        Permissions this principal holds, in plain language — the raw resource
        id stays as a secondary reference. Only repeated tool grants from the
        same package are grouped into one row; expand a group to see its
        individual rules.
      </FacetDesc>
      {items.length === 0 ? (
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
                {items.map((item) =>
                  item.kind === "row" ? (
                    <GrantFlatRow key={item.row.id} row={item.row} />
                  ) : (
                    <GrantGroupRow key={item.group.key} group={item.group} />
                  ),
                )}
              </tbody>
            </table>
          </div>
        </FacetCard>
      )}
    </div>
  );
}

/** A single raw grant rule row, unchanged from the pre-grouping presentation. */
function GrantFlatRow({ row: g }: { row: GrantRow }) {
  return (
    <tr
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
  );
}

/**
 * One collapsed group row per resource family with 2+ rules, with its own
 * local expand state (default collapsed — CL-3919). A deny rule anywhere in
 * the group is NEVER folded away inside an "allowed" summary: it always
 * surfaces its own visible marker on the row, and deny rules sort first once
 * expanded.
 */
function GrantGroupRow({ group }: { group: GrantGroup }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `grant-group-panel-${group.key}`;

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
            aria-controls={panelId}
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
        <tr id={panelId}>
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
                    <GrantFlatRow key={g.id} row={g} />
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

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-border pb-2 pr-3 text-left font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-text-3">
      {children}
    </th>
  );
}

export function Td({
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
