// The sidebar's bench dock: a trigger showing the active bench name
// that opens an upward listbox popover to switch benches or create a
// new one. Anatomy follows the app-chrome workspace-switcher pattern —
// trigger (icon, truncated name, chevron), invisible click-catcher,
// `role="listbox"` panel — with every label the server-resolved bench
// name, never a tenant id.
//
// Split into stateless pieces (`BenchSwitcherTrigger`,
// `BenchSwitcherList`) plus the composed `BenchSwitcher` that owns the
// open state and the create flow, so other sidebar variants can compose
// the same parts.

import { ChevronDown, LayoutGrid, Plus } from "lucide-react";
import { useState } from "react";

import { BenchApiError, createBench } from "./api";
import type { Bench, BenchMembership } from "./api";
import { CreateBenchDialog } from "./create-bench-dialog";
import { deriveBenchSlug, membershipDisplay } from "./membership";
import { BENCH_STRINGS } from "./strings";

export function createBenchErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError && cause.status === 409) {
    return BENCH_STRINGS.createBenchConflictError;
  }
  return BENCH_STRINGS.createBenchError;
}

export function BenchSwitcherTrigger({
  activeName,
  open,
  onToggle,
}: {
  readonly activeName: string | null;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="bench-switcher-trigger"
      onClick={onToggle}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={BENCH_STRINGS.switcherLabel}
    >
      <LayoutGrid size={17} aria-hidden />
      <span className="bench-switcher-name">
        {activeName ?? BENCH_STRINGS.switcherEmpty}
      </span>
      <ChevronDown size={14} aria-hidden />
    </button>
  );
}

export function BenchSwitcherList({
  memberships,
  activeTenantId,
  onSelect,
  onCreate,
}: {
  readonly memberships: readonly BenchMembership[];
  readonly activeTenantId: string | null;
  readonly onSelect: (tenantId: string) => void;
  readonly onCreate: () => void;
}) {
  return (
    <div
      className="bench-switcher-popover"
      role="listbox"
      aria-label={BENCH_STRINGS.switcherLabel}
    >
      <button
        type="button"
        className="bench-switcher-create"
        onClick={onCreate}
      >
        <Plus size={14} aria-hidden />
        {BENCH_STRINGS.createBenchAction}
      </button>
      {memberships.map((membership) => {
        const display = membershipDisplay(membership);
        const active = display.tenantId === activeTenantId;
        return (
          <button
            key={display.tenantId}
            type="button"
            role="option"
            aria-selected={active}
            className="bench-switcher-option"
            onClick={() => onSelect(display.tenantId)}
          >
            {display.name}
          </button>
        );
      })}
    </div>
  );
}

export function BenchSwitcher({
  memberships,
  activeTenantId,
  onSelect,
  onBenchCreated,
}: {
  readonly memberships: readonly BenchMembership[];
  readonly activeTenantId: string | null;
  readonly onSelect: (tenantId: string) => void;
  readonly onBenchCreated: (bench: Bench) => void;
}) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const active =
    activeTenantId === null
      ? undefined
      : memberships.find(
          (membership) => membership.tenantId === activeTenantId,
        );
  const activeName =
    active !== undefined ? membershipDisplay(active).name : null;

  function handleCreate(name: string) {
    setCreateSubmitting(true);
    setCreateError(null);
    createBench({ name, slug: deriveBenchSlug(name) })
      .then((bench) => {
        setCreateSubmitting(false);
        setCreateOpen(false);
        onBenchCreated(bench);
      })
      .catch((cause: unknown) => {
        setCreateSubmitting(false);
        setCreateError(createBenchErrorMessage(cause));
      });
  }

  return (
    <div className="bench-switcher">
      <BenchSwitcherTrigger
        activeName={activeName}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      />
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="bench-switcher-scrim"
            onClick={() => setOpen(false)}
          />
          <BenchSwitcherList
            memberships={memberships}
            activeTenantId={activeTenantId}
            onSelect={(tenantId) => {
              onSelect(tenantId);
              setOpen(false);
            }}
            onCreate={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
          />
        </>
      )}
      <CreateBenchDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
        submitting={createSubmitting}
        error={createError}
      />
    </div>
  );
}
