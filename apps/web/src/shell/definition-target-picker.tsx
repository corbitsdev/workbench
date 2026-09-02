// An explicit picker over `GET /api/tenants/:tenantId/workflows/targets`
// (CL-7355): the routine panel used to infer a create target from the
// conversation's own agent (`listWorkbenchAgents(...)[0]`) — silently wrong
// the moment a workbench hosted more than one agent, or none. This picker
// instead lists every deployed, frozen definition the signed-in principal
// may target, grouped presentationally by `kind` (Agents / Workflows), and
// leaves the choice to the person — it never auto-selects the first item.
import { useEffect, useState } from "react";
import { Button, EmptyState, Select, Skeleton } from "@corbits/react-ui";
import { Robot } from "@corbits/icons";

import { useNavigate } from "../navigation";
import { listAllRoutineTargets } from "../routines-api";
import type { RoutineTarget } from "../routines-api";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loaded"; readonly targets: readonly RoutineTarget[] };

/** `value`/`onChange` carry a `definitionAssetId` — the stable identity a
 * routine stores. `preselectedAssetId` lets a caller that already knows
 * which target it wants seed the initial selection explicitly; the picker
 * itself never guesses one on the person's behalf. */
export function DefinitionTargetPicker({
  tenantId,
  value,
  onChange,
  preselectedAssetId,
}: {
  readonly tenantId: string | null;
  readonly value: string | null;
  readonly onChange: (definitionAssetId: string) => void;
  readonly preselectedAssetId?: string;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  // Bumping this re-runs the load effect below without depending on
  // `tenantId` changing — the retry button's only job.
  const [retryTick, setRetryTick] = useState(0);

  // Deps are `[tenantId, retryTick]` only, not `[tenantId, value, onChange,
  // preselectedAssetId]` — this picker has exactly one caller today
  // (`RoutinePanel`), which remounts on subject change and passes a stable
  // `onChange` (`useState`+ref, per its own comment), so a stale closure
  // over those three can't happen in practice. If a second caller ever
  // reuses this component without remounting on `preselectedAssetId`
  // changes, add it to this array (and accept the extra re-fetch that
  // implies) rather than relying on this invariant silently.
  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setState({ kind: "loading" });
    void listAllRoutineTargets(tenantId).then(
      (targets) => {
        if (cancelled) return;
        setState({ kind: "loaded", targets });
        if (
          preselectedAssetId !== undefined &&
          value === null &&
          targets.some((t) => t.definitionAssetId === preselectedAssetId)
        ) {
          onChange(preselectedAssetId);
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  }, [tenantId, retryTick]);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-col gap-1.5" aria-busy="true" aria-live="polite">
        <span className="text-xs font-medium">What should this routine run?</span>
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col gap-1.5" aria-live="polite">
        <span className="text-xs font-medium">What should this routine run?</span>
        <p className="text-xs text-[var(--ui-danger)]" role="alert">
          {state.message}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRetryTick((tick) => tick + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  const { targets } = state;

  if (targets.length === 0) {
    return (
      <EmptyState
        icon={<Robot />}
        title="No deployable workflows yet — author or install one"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate("/settings/agents")}
          >
            Go to Agents
          </Button>
        }
      />
    );
  }

  const nameCounts = new Map<string, number>();
  for (const target of targets) {
    nameCounts.set(target.name, (nameCounts.get(target.name) ?? 0) + 1);
  }
  const labelFor = (target: RoutineTarget): string =>
    (nameCounts.get(target.name) ?? 0) > 1
      ? `${target.name} (${target.assetName})`
      : target.name;

  const agents = targets.filter((t) => t.kind === "agent");
  const workflows = targets.filter((t) => t.kind === "workflow");
  const selected = targets.find((t) => t.definitionAssetId === value) ?? null;
  const stale = value !== null && selected === null;

  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <label htmlFor="routine-panel-target" className="text-xs font-medium">
        What should this routine run?
      </label>
      <Select
        id="routine-panel-target"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          Choose a target…
        </option>
        {stale ? (
          // Intentionally the raw id, not `labelFor` — a stale target has
          // no entry in `targets`/`nameCounts` to look a display name up
          // against; showing the id honestly is the point.
          <option value={value as string} disabled>
            {value} (unavailable)
          </option>
        ) : null}
        {agents.length > 0 ? (
          <optgroup label="Agents">
            {agents.map((target) => (
              <option key={target.definitionAssetId} value={target.definitionAssetId}>
                {labelFor(target)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {workflows.length > 0 ? (
          <optgroup label="Workflows">
            {workflows.map((target) => (
              <option key={target.definitionAssetId} value={target.definitionAssetId}>
                {labelFor(target)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
      {stale ? (
        <p className="text-xs text-[var(--ui-danger)]" role="alert">
          This routine's target is no longer available — pick a new one.
        </p>
      ) : selected?.description !== null && selected?.description !== undefined ? (
        <p className="text-xs text-[var(--ui-fg-muted)]">{selected.description}</p>
      ) : null}
    </div>
  );
}
