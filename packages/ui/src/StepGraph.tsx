import { motion, useReducedMotion, type Variants } from "framer-motion";
import { useId, useMemo } from "react";
import {
  buildStepGraphEdgePath,
  sequentialStepEdges,
  type StepGraphLayoutAxis,
} from "./chart-geometry";

export type StepGraphKind = "auto" | "agent" | "human";

export type StepGraphStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | undefined;

export interface StepGraphStep {
  id: string;
  title: string;
  kind: StepGraphKind;
  status?: StepGraphStatus;
}

export interface StepGraphEdge {
  from: string;
  to: string;
}

const KIND_LABEL: Record<StepGraphKind, string> = {
  auto: "Automated",
  agent: "AI agent",
  human: "Your input",
};

const CHIP_CLASS: Record<StepGraphKind, string> = {
  auto: "border-border bg-surface-2",
  agent: "border-blue/40 bg-blue/5",
  human: "border-orange/50 bg-[rgba(233,132,40,0.08)]",
};

const NODE_CLASS: Record<StepGraphKind, string> = {
  auto: "border-border bg-surface text-text-3",
  agent: "border-blue/40 bg-blue/10 text-blue",
  human: "border-orange/50 bg-[rgba(233,132,40,0.12)] text-orange-deep",
};

const BADGE_CLASS: Record<StepGraphKind, string> = {
  auto: "text-text-3",
  agent: "text-blue",
  human: "text-orange-deep",
};

const GLYPH: Record<StepGraphKind, string> = {
  auto: "●",
  agent: "◆",
  human: "★",
};

interface DensitySpec {
  nodeWidth: number;
  nodeHeight: number;
  gap: number;
  nodeInset: number;
  crossCenter: number;
  padding: number;
  axis: StepGraphLayoutAxis;
}

const DENSITY: Record<"compact" | "expanded", DensitySpec> = {
  compact: {
    nodeWidth: 172,
    nodeHeight: 48,
    gap: 20,
    nodeInset: 14,
    crossCenter: 18,
    padding: 4,
    axis: "horizontal",
  },
  expanded: {
    nodeWidth: 240,
    nodeHeight: 56,
    gap: 28,
    nodeInset: 18,
    crossCenter: 120,
    padding: 8,
    axis: "vertical",
  },
};

function graphSpan(count: number, spec: DensitySpec): number {
  if (count <= 0) return 0;
  if (spec.axis === "horizontal") {
    return (
      spec.padding * 2 +
      count * spec.nodeWidth +
      Math.max(0, count - 1) * spec.gap
    );
  }
  return (
    spec.padding * 2 +
    count * spec.nodeHeight +
    Math.max(0, count - 1) * spec.gap
  );
}

function nodeOffset(index: number, spec: DensitySpec): { left: number; top: number } {
  if (spec.axis === "horizontal") {
    return {
      left: spec.padding + index * (spec.nodeWidth + spec.gap),
      top: spec.crossCenter + 10,
    };
  }
  return {
    left: spec.padding,
    top: spec.padding + index * (spec.nodeHeight + spec.gap),
  };
}

function statusRingClass(status: StepGraphStatus | undefined): string {
  switch (status) {
    case "completed":
      return "ring-2 ring-green/70";
    case "running":
      return "ring-2 ring-orange";
    case "failed":
      return "ring-2 ring-red";
    case "pending":
      return "ring-1 ring-border-strong";
    default:
      return "";
  }
}

function statusGlyph(status: StepGraphStatus | undefined): string | null {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "!";
    case "running":
      return "…";
    default:
      return null;
  }
}

export interface StepGraphProps {
  steps: readonly StepGraphStep[];
  edges?: readonly StepGraphEdge[];
  density?: "compact" | "expanded";
  /** Re-keys staggered draw-in when the surrounding context changes (e.g. catalog row). */
  animationKey?: string;
  emptyMessage?: string;
}

/**
 * SVG step graph: nodes in run order with drawn connectors. Kind colours and
 * optional per-step status overlays; compact horizontal layout for catalog
 * previews, expanded vertical layout for run/trace panes.
 */
export function StepGraph({
  steps,
  edges,
  density = "compact",
  animationKey = "step-graph",
  emptyMessage = "This workflow has no preview available. You can still run it.",
}: StepGraphProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const labelId = useId();
  const spec = DENSITY[density];

  const resolvedEdges = useMemo(() => {
    if (edges !== undefined && edges.length > 0) return edges;
    return sequentialStepEdges(steps.map((s) => s.id));
  }, [edges, steps]);

  const layout = useMemo(() => {
    const span = graphSpan(steps.length, spec);
    const centers = Array.from({ length: steps.length }, (_, index) => {
      const { left, top } = nodeOffset(index, spec);
      if (spec.axis === "horizontal") {
        return { x: left + spec.nodeWidth / 2, y: top + 14 };
      }
      return {
        x: left + spec.nodeWidth / 2,
        y: top + spec.nodeHeight / 2,
      };
    });
    const width =
      spec.axis === "horizontal"
        ? span
        : spec.nodeWidth + spec.padding * 2;
    const height =
      spec.axis === "horizontal"
        ? spec.nodeHeight + spec.crossCenter + 24
        : span;
    return { centers, width, height, span };
  }, [steps.length, spec]);

  const idToIndex = useMemo(
    () => new Map(steps.map((s, i) => [s.id, i])),
    [steps],
  );

  if (steps.length === 0) {
    return (
      <p className="text-[13px] text-text-3" data-testid="step-graph-empty">
        {emptyMessage}
      </p>
    );
  }

  const container: Variants = {
    hidden: {},
    show: {
      transition: { staggerChildren: reduceMotion ? 0 : 0.04 },
    },
  };
  const item: Variants = reduceMotion
    ? { hidden: { opacity: 1 }, show: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y: 6 },
        show: {
          opacity: 1,
          y: 0,
          transition: { type: "spring", stiffness: 460, damping: 32 },
        },
      };

  const edgeMotion = reduceMotion
    ? { pathLength: 1, opacity: 1 }
    : { pathLength: 1, opacity: 1 };

  return (
    <figure
      className="flex flex-col gap-0"
      data-testid="step-graph"
      aria-labelledby={labelId}
    >
      <p id={labelId} className="sr-only">
        {`Workflow steps: ${steps.map((s, i) => `${i + 1}. ${s.title}`).join("; ")}`}
      </p>
      <div
        className={
          density === "compact"
            ? "overflow-x-auto pb-1"
            : "overflow-y-auto"
        }
      >
        <div
          className="relative"
          style={{ width: layout.width, height: layout.height, minWidth: "100%" }}
        >
          <svg
            className="pointer-events-none absolute left-0 top-0 text-border-strong"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-hidden="true"
            data-testid="step-graph-edges"
          >
            <defs>
              <marker
                id={`${labelId}-arrow`}
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 Z" className="fill-border-strong" />
              </marker>
            </defs>
            {resolvedEdges.map((edge, edgeIndex) => {
              const fromIdx = idToIndex.get(edge.from);
              const toIdx = idToIndex.get(edge.to);
              if (fromIdx === undefined || toIdx === undefined) return null;
              const fromCenter = layout.centers[fromIdx]!;
              const toCenter = layout.centers[toIdx]!;
              const d = buildStepGraphEdgePath(
                fromCenter,
                toCenter,
                spec.nodeInset,
                spec.axis,
              );
              if (d === "") return null;
              return (
                <motion.path
                  key={`${edge.from}-${edge.to}`}
                  className="step-graph-edge"
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  markerEnd={`url(#${labelId}-arrow)`}
                  initial={
                    reduceMotion
                      ? edgeMotion
                      : { pathLength: 0, opacity: 0.4 }
                  }
                  animate={edgeMotion}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : {
                          pathLength: {
                            delay: 0.05 + edgeIndex * 0.05,
                            duration: 0.35,
                            ease: "easeOut",
                          },
                          opacity: { duration: 0.2 },
                        }
                  }
                />
              );
            })}
          </svg>

          <motion.ol
            key={animationKey}
            className="relative m-0 list-none p-0"
            variants={container}
            initial="hidden"
            animate="show"
          >
            {steps.map((step, index) => {
              const { left, top } = nodeOffset(index, spec);
              const statusMark = statusGlyph(step.status);
              return (
                <motion.li
                  key={step.id}
                  variants={item}
                  className={`absolute flex items-center gap-2.5 rounded-[10px] border px-2.5 py-2 ${CHIP_CLASS[step.kind]} ${statusRingClass(step.status)}`}
                  style={{
                    width: spec.nodeWidth,
                    minHeight: spec.nodeHeight,
                    left,
                    top,
                  }}
                >
                  <span
                    className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border text-[10px] font-bold tabular-nums ${NODE_CLASS[step.kind]}`}
                  >
                    {statusMark ?? index + 1}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[12.5px] font-semibold leading-tight text-text">
                      {step.title}
                    </span>
                    <span
                      className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.04em] ${BADGE_CLASS[step.kind]}`}
                    >
                      <span aria-hidden="true">{GLYPH[step.kind]}</span>
                      {KIND_LABEL[step.kind]}
                    </span>
                  </div>
                </motion.li>
              );
            })}
          </motion.ol>
        </div>
      </div>
    </figure>
  );
}

export { KIND_LABEL as stepGraphKindLabel, GLYPH as stepGraphKindGlyph };