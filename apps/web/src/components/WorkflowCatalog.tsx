import { useMemo, useState } from "react";
import type { WorkflowCatalogEntry } from "@workbench/shared";
import { useStartWorkflow } from "../hooks/use-workflow";
import {
  useToggleWorkflowFavorite,
  useWorkflowsCatalog,
} from "../hooks/use-workflows-catalog";
import { WorkflowFlowPreview } from "./WorkflowFlowPreview";
import { SchedulePopover } from "./SchedulePopover";

export interface WorkflowCatalogProps {
  tenantId: string | null;
  onWorkflowStarted: (runId: string) => void;
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 2l2.9 6.3 6.9.6-5.2 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.2 8.9l6.9-.6z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CatalogRow({
  entry,
  selected,
  favoritePending,
  onSelect,
  onToggleFavorite,
}: {
  entry: WorkflowCatalogEntry;
  selected: boolean;
  favoritePending: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div
      className={`relative flex items-center gap-2 border-b border-border/60 last:border-b-0 ${
        selected ? "bg-[var(--sel,rgba(233,132,40,0.08))]" : ""
      }`}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-[3px] bg-accent"
        />
      )}
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-4 py-3 text-left transition-colors hover:bg-row-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
      >
        <span className="truncate text-[13.5px] font-semibold text-text">
          {entry.label}
        </span>
        <span className="flex items-center gap-1.5 text-[11.5px] text-text-3">
          {entry.stepCount} steps
          {entry.pauseCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              {entry.pauseCount} {entry.pauseCount === 1 ? "pause" : "pauses"}
            </>
          )}
        </span>
      </button>
      <button
        type="button"
        disabled={favoritePending}
        aria-pressed={entry.isFavorite}
        aria-label={
          entry.isFavorite
            ? `Unfavorite ${entry.label}`
            : `Favorite ${entry.label}`
        }
        onClick={onToggleFavorite}
        className={`mr-2 grid h-8 w-8 place-items-center rounded-[7px] transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-50 ${
          entry.isFavorite
            ? "text-accent"
            : "text-text-3 hover:text-accent-deep"
        }`}
      >
        <StarIcon filled={entry.isFavorite} />
      </button>
    </div>
  );
}

function CatalogGroup({
  title,
  entries,
  selectedKind,
  favoritePending,
  onSelect,
  onToggleFavorite,
}: {
  title: string;
  entries: WorkflowCatalogEntry[];
  selectedKind: string | null;
  favoritePending: boolean;
  onSelect: (kind: string) => void;
  onToggleFavorite: (entry: WorkflowCatalogEntry) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="border-b border-border bg-surface-2 px-4 py-2 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-3">
        {title}
      </div>
      {entries.map((entry) => (
        <CatalogRow
          key={entry.kind}
          entry={entry}
          selected={selectedKind === entry.kind}
          favoritePending={favoritePending}
          onSelect={() => onSelect(entry.kind)}
          onToggleFavorite={() => onToggleFavorite(entry)}
        />
      ))}
    </div>
  );
}

function PreviewPanel({
  entry,
  starting,
  startPending,
  error,
  redeploying,
  onStart,
}: {
  entry: WorkflowCatalogEntry;
  starting: boolean;
  startPending: boolean;
  error: string | null;
  redeploying: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col gap-5 rounded-[16px] border border-border bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-[18px] font-bold tracking-[-0.015em] text-text">
          {entry.label}
        </h3>
        {entry.description !== undefined && (
          <p className="max-w-[52ch] text-[13.5px] leading-relaxed text-text-2">
            {entry.description}
          </p>
        )}
      </div>

      <div className="flex gap-5 text-[12px] text-text-2">
        <span>{`${entry.stepCount} ${entry.stepCount === 1 ? "step" : "steps"}`}</span>
        <span>
          {entry.pauseCount === 0
            ? "Runs without stopping"
            : `Pauses ${entry.pauseCount} ${entry.pauseCount === 1 ? "time" : "times"} for you`}
        </span>
      </div>

      <WorkflowFlowPreview steps={entry.steps} animationKey={entry.kind} />

      {redeploying && (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-text-2">
          Finishing an update — retrying…
        </div>
      )}
      {error && !redeploying && (
        <div className="rounded-lg border border-orange bg-[rgba(233,132,40,0.12)] px-3 py-2 text-[13px] text-orange-deep">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4 border-t border-border pt-4">
        <button
          type="button"
          disabled={startPending}
          onClick={onStart}
          className="inline-flex items-center gap-2 rounded-[10px] bg-accent px-5 py-2.5 text-[14px] font-bold text-white shadow-[0_4px_14px_rgba(191,107,32,0.32)] transition-transform hover:bg-accent-deep active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-50 motion-reduce:active:scale-100 motion-reduce:transition-none"
        >
          {starting ? "Starting…" : "Start run"}
        </button>
        <SchedulePopover kind={entry.kind} label={entry.label} />
      </div>
    </div>
  );
}

// The Workflows catalog: a two-pane browse/launch surface driven by the single
// GET /workflows call. The left list pins favorites; selecting a workflow shows
// its step-flow preview on the right. A click on Start launches the run (gates
// collect input after start).
export function WorkflowCatalog({
  tenantId,
  onWorkflowStarted,
}: WorkflowCatalogProps) {
  const { data, isPending, isError } = useWorkflowsCatalog(tenantId);
  const toggleFavorite = useToggleWorkflowFavorite(tenantId);
  const startWorkflow = useStartWorkflow(tenantId);

  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redeploying, setRedeploying] = useState(false);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const favorites = entries.filter((e) => e.isFavorite);
  const rest = entries.filter((e) => !e.isFavorite);

  // Selection is derived from the loaded catalog: the chosen kind if it still
  // exists, otherwise the first entry — no navigation prop drives it.
  const selected =
    entries.find((e) => e.kind === selectedKind) ?? entries[0] ?? null;

  const startingKind = startWorkflow.isPending
    ? (startWorkflow.variables?.kind ?? null)
    : null;

  const handleStart = () => {
    if (!selected || startWorkflow.isPending) return;
    setError(null);
    setRedeploying(false);
    startWorkflow
      .mutateAsync({
        kind: selected.kind,
        input: {},
        onRedeploying: () => setRedeploying(true),
      })
      .then((res) => onWorkflowStarted(res.runId))
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not start the workflow.",
        );
      })
      .finally(() => setRedeploying(false));
  };

  const handleToggleFavorite = (entry: WorkflowCatalogEntry) => {
    toggleFavorite
      .mutateAsync({ kind: entry.kind, nextFavorite: !entry.isFavorite })
      .catch(() => {
        /* optimistic update already rolled back in the hook */
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-[15px] font-bold tracking-[-0.01em] text-text">
        Catalog
      </h2>

      {isPending && (
        <p className="py-4 text-[13px] text-text-3">Loading workflows…</p>
      )}
      {isError && (
        <p className="py-4 text-[13px] text-text-2">
          Couldn&rsquo;t load the workflow catalog. Refresh to try again.
        </p>
      )}
      {!isPending && !isError && entries.length === 0 && (
        <p className="py-4 text-[13px] text-text-3">
          No workflows are available to run in this workbench. Your admin may
          need to deploy workflows or enable them for members.
        </p>
      )}

      {!isPending && !isError && entries.length > 0 && selected && (
        <div className="grid grid-cols-1 gap-5 @[820px]:grid-cols-[minmax(280px,1fr)_1.4fr]">
          <div className="overflow-hidden rounded-[16px] border border-border bg-surface">
            <CatalogGroup
              title="Favorites"
              entries={favorites}
              selectedKind={selected.kind}
              favoritePending={toggleFavorite.isPending}
              onSelect={setSelectedKind}
              onToggleFavorite={handleToggleFavorite}
            />
            <CatalogGroup
              title={favorites.length > 0 ? "All workflows" : "Workflows"}
              entries={rest}
              selectedKind={selected.kind}
              favoritePending={toggleFavorite.isPending}
              onSelect={setSelectedKind}
              onToggleFavorite={handleToggleFavorite}
            />
          </div>

          <PreviewPanel
            entry={selected}
            starting={startingKind === selected.kind}
            startPending={startWorkflow.isPending}
            error={error}
            redeploying={redeploying}
            onStart={handleStart}
          />
        </div>
      )}
    </div>
  );
}
