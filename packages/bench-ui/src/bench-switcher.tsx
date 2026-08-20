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

import { CaretDown, Plus } from "@corbits/icons";
import { useState } from "react";

import { BenchApiError, createBench, patchBenchSettings } from "./api";
import type { Bench, BenchMembership } from "./api";
import { CreateBenchDialog } from "./create-bench-dialog";
import type { BenchCreateType } from "./create-bench-dialog";
import { deriveBenchSlug, membershipDisplay } from "./membership";
import { BENCH_STRINGS } from "./strings";

export function createBenchErrorMessage(cause: unknown): string {
  if (cause instanceof BenchApiError && cause.status === 409) {
    return BENCH_STRINGS.createBenchConflictError;
  }
  return BENCH_STRINGS.createBenchError;
}

/** Square monogram for the trigger — the first letters of up to two words. */
export function benchMonogram(name: string | null): string {
  if (name === null) return "··";
  const initials = name
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return initials.length > 0 ? initials : "··";
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
      <span className="bench-switcher-mark" aria-hidden>
        {benchMonogram(activeName)}
      </span>
      <span className="bench-switcher-name">
        {activeName ?? BENCH_STRINGS.switcherEmpty}
      </span>
      <CaretDown size={14} aria-hidden />
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

  function handleCreate(
    name: string,
    purpose?: string,
    benchType?: BenchCreateType,
  ) {
    setCreateSubmitting(true);
    setCreateError(null);
    createBench({ name, slug: deriveBenchSlug(name) })
      .then(async (bench) => {
        // Purpose/type aren't part of the native tenant-creation route
        // (see create-bench-dialog.tsx's header note), so they land via a
        // follow-up PATCH once the bench itself exists. A failure here is
        // swallowed on purpose: the bench was already created successfully,
        // and losing the purpose/type it was given is a smaller problem
        // than reporting a creation failure that didn't happen.
        if (purpose !== undefined || benchType !== undefined) {
          try {
            const patch =
              purpose !== undefined && benchType !== undefined
                ? { purpose, type: benchType }
                : purpose !== undefined
                  ? { purpose }
                  : benchType !== undefined
                    ? { type: benchType }
                    : {};
            await patchBenchSettings(bench.id, patch);
          } catch {
            // best-effort, see comment above
          }
        }
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
