import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clipboard, Info } from "lucide-react";
import { statusToneClass, type StatusTone } from "./status-tone";

/**
 * Shared presentational shell for the two tracer surfaces (principal trace and
 * execution trace): a compact identity header, an underlined facet tab bar
 * (with a gap dot on facets that expose a "not recorded yet" gap), and a subtle
 * inline stat strip. App-native chrome —
 * corbits-light surfaces, orange (`accent`) accent, standard card/label
 * language — matching the Insights dashboard, not a distinct artifact.
 *
 * These are pure presentation — every value they render is derived by the page
 * from real loaded data or is an explicit honest-gap notice. Nothing here
 * fabricates data. Design tokens only (no hardcoded colors/radii).
 */

export type RootTone = "identity" | "run";

export interface TraceRoot {
  /** Short kind chip, e.g. "agent", "workflow", "principal". */
  kindChip: string;
  /** Plain-language name — the headline. */
  name: string;
  /** Raw id, shown only as a secondary mono line. Click the copy affordance to copy. */
  rawId: string;
  tone: RootTone;
}

export interface FacetDef {
  id: string;
  label: string;
  /** The facet surfaces a "not recorded yet" data gap. */
  hasGap: boolean;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function avatarToneClass(tone: RootTone): string {
  return tone === "run" ? "bg-accent-deep" : "bg-accent";
}

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return Promise.resolve(false);
  }
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  );
}

/** Compact copy affordance for IDs and short strings in trace headers. */
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  return (
    <button
      type="button"
      aria-label="Copy ID"
      title="Copy ID"
      onClick={() => {
        void copyText(id).then((ok) => {
          if (!ok) return;
          setCopied(true);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-[3px] text-text-3 transition hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.95]"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green" />
      ) : (
        <Clipboard className="h-3 w-3" />
      )}
    </button>
  );
}

export interface StatusPill {
  tone: StatusTone;
  label: string;
}

/** Compact identity header: avatar, name, kind + raw id, status pill. */
export function CompactHeader({
  root,
  status,
  backTo,
}: {
  root: TraceRoot;
  /**
   * The status pill, or null when the subject's live state is unknown (e.g. an
   * identity that hasn't loaded or failed to load). Null renders NO pill rather
   * than asserting a fabricated "Active" state for an unknown principal.
   */
  status: StatusPill | null;
  backTo: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Link
        to={backTo}
        className="inline-flex w-fit items-center gap-1 rounded-[8px] px-1.5 py-1 text-[12px] font-medium text-text-3 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Insights
      </Link>
      <div className="flex items-center gap-3">
        <span
          className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] text-[13px] font-bold text-white ${avatarToneClass(
            root.tone,
          )}`}
          aria-hidden
        >
          {initialsOf(root.name)}
        </span>
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-balance text-text">
            {root.name}
          </h1>
          <p className="flex flex-wrap items-baseline gap-1.5 text-[11.5px] text-text-3">
            <span>{root.kindChip}</span>
            <span aria-hidden>·</span>
            <span className="font-mono text-[10.5px] text-text-3">
              {root.rawId}
            </span>
            <CopyId id={root.rawId} />
          </p>
        </div>
        {status !== null && (
          <span
            data-testid="trace-status-pill"
            className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[9.5px] uppercase tracking-[0.05em] ${statusToneClass(
              status.tone,
            )}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {status.label}
          </span>
        )}
      </div>
    </div>
  );
}

/** Underlined, numbered facet tab bar with a gap dot on gap-bearing facets. */
export function FacetTabs({
  facets,
  activeId,
  onSelect,
}: {
  facets: FacetDef[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Trace facets"
      className="flex gap-0.5 overflow-x-auto border-b border-border"
    >
      {facets.map((f, i) => {
        const active = f.id === activeId;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(f.id)}
            className={`-mb-px flex min-h-[40px] shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[12.5px] font-semibold outline-none transition-[color,border-color] duration-150 focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] ${
              active
                ? "border-accent text-text"
                : "border-transparent text-text-3 hover:text-text"
            }`}
          >
            <span
              className={`font-mono text-[9.5px] ${
                active ? "text-accent" : "text-text-3"
              }`}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            {f.label}
            {f.hasGap && (
              <span
                aria-label="has a data gap"
                className="h-1.5 w-1.5 rounded-full bg-gold"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface Stat {
  label: string;
  value: string;
  /** Render the value in the accent-deep cost color. */
  cost?: boolean;
}

/** A subtle one-line stat strip — inline label/value pairs, never KPI cards. */
export function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <dl
      data-testid="trace-stat-strip"
      className="flex flex-wrap gap-x-6 gap-y-1 px-0.5 pt-2.5 text-[12px]"
    >
      {stats.map((s) => (
        <div key={s.label} className="flex items-baseline gap-1.5">
          <dt className="font-mono text-[9px] uppercase tracking-[0.09em] text-text-3">
            {s.label}
          </dt>
          <dd
            className={`text-[13px] font-bold tabular-nums tracking-[-0.01em] ${
              s.cost ? "text-accent-deep" : "text-text"
            }`}
          >
            {s.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One-line facet description. */
export function FacetDesc({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3.5 mt-0.5 max-w-[70ch] text-pretty text-[12.5px] text-text-2">
      {children}
    </p>
  );
}

/**
 * Honest "not recorded yet" banner — the artifact's gap-banner, in the gold
 * attention hue, with an Info icon and plain-language message.
 */
export function GapBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="facet-gap-banner"
      className="mb-2.5 flex items-start gap-2.5 rounded-[8px] border border-dashed border-cream-deep bg-cream/40 px-3 py-2 text-[12px] text-text-2"
    >
      <Info className="mt-px h-3.5 w-3.5 shrink-0 text-gold" />
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** A surface card wrapper matching the artifact's facet cards. */
export function FacetCard({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 rounded border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      {title !== undefined && (
        <h3 className="mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-3">
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export interface TraceNode {
  kind: string;
  label: string;
  rawId: string;
  meta: string;
  /** Cross-link to this entity's own trace, when one exists on real data. */
  to?: string;
}

/** A grid of linked-entity cards (Connections / Generated facets). */
export function NodeGrid({ nodes }: { nodes: TraceNode[] }) {
  return (
    <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(215px,1fr))]">
      {nodes.map((n) => {
        const inner = (
          <>
            <span className="block font-mono text-[8px] uppercase tracking-[0.06em] text-text-3">
              {n.kind}
            </span>
            <span className="mt-1 block text-[12.5px] font-semibold text-text">
              {n.label}
            </span>
            <span className="mt-0.5 block break-all font-mono text-[9.5px] text-text-3">
              {n.rawId}
            </span>
            <span className="mt-1.5 block text-[11px] text-text-2">
              {n.meta}
            </span>
            {n.to !== undefined && (
              <span className="mt-1.5 flex items-center gap-1 text-[10.5px] font-semibold text-accent">
                Trace <ArrowRight className="h-3 w-3" />
              </span>
            )}
          </>
        );
        const cls =
          "block rounded-[10px] border border-border bg-surface p-3 text-left shadow-[var(--shadow-card)] transition-[colors,box-shadow]";
        if (n.to !== undefined) {
          return (
            <Link
              key={`${n.kind}:${n.rawId}`}
              to={n.to}
              data-testid="connection-node"
              className={`${cls} outline-none hover:border-accent focus-visible:ring-1 focus-visible:ring-accent`}
            >
              {inner}
            </Link>
          );
        }
        return (
          <div
            key={`${n.kind}:${n.rawId}`}
            data-testid="connection-node"
            className={cls}
          >
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/** Quiet gap chip for moment-level fields the record model does not yet carry. */
export function HonestGapChip({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="inline-block rounded-[6px] border border-border bg-surface-2 px-2 py-1 font-mono text-[10.5px] text-text-3"
    >
      {children}
    </span>
  );
}

/** Sticky bottom nav: back to Insights roster and previous/next facet. */
export function TracerFacetNav({
  backTo,
  facets,
  activeIndex,
  onFacetIndexChange,
}: {
  backTo: string;
  facets: FacetDef[];
  activeIndex: number;
  onFacetIndexChange: (index: number) => void;
}) {
  const atStart = activeIndex <= 0;
  const atEnd = activeIndex >= facets.length - 1;
  return (
    <nav
      data-testid="tracer-facet-nav"
      className="sticky bottom-0 z-10 -mx-1 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-1 py-3"
    >
      <Link
        to={backTo}
        className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1.5 text-[12px] font-medium text-text-3 outline-none transition-colors hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Insights
      </Link>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={atStart}
          onClick={() => onFacetIndexChange(Math.max(0, activeIndex - 1))}
          className="rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-accent"
        >
          Previous facet
        </button>
        <button
          type="button"
          disabled={atEnd}
          onClick={() =>
            onFacetIndexChange(Math.min(facets.length - 1, activeIndex + 1))
          }
          className="rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-accent"
        >
          Next facet
        </button>
      </div>
    </nav>
  );
}
