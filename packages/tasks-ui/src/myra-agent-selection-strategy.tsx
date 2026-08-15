// CL-6051 ("Myra auto-dispatch"): lets a person type an outcome and
// have Myra pick or create the right agent, instead of always picking
// one by hand. `TaskComposerDialog`'s submit gate is driven entirely by
// `definitionId` being non-null (see `canSubmitTask` in
// ./task-composer-dialog.tsx) — this strategy rides that exact path
// unchanged by reporting a reserved sentinel, `MYRA_AUTO_SELECTION_ID`,
// as the selected id. `TaskComposerDialog` needs zero changes.
//
// Contract for whatever consumes `onCreate({definitionId, prompt, ...})`
// later (apps/web, not this package's concern): when `definitionId ===
// MYRA_AUTO_SELECTION_ID`, the prompt must be routed to the planner
// instead of launched against a real agent — the planner picks or
// creates the agent and dispatches it. Any other `definitionId` is a
// real agent id and launches exactly as it does today.
import { useCallback, useEffect, useState } from "react";

import {
  createManualAgentSelectionStrategy,
  type AgentSelectionStrategy,
  type TaskAgentOption,
} from "./agent-selection-strategy";

/**
 * Reserved `definitionId` meaning "let Myra choose." Never a real agent
 * id — real ids are asset-store-generated and never take this shape.
 */
export const MYRA_AUTO_SELECTION_ID = "__myra_auto__";

/**
 * The default strategy for CL-6051: two options, "Let Myra choose" (the
 * default) and "Choose an agent yourself," which reveals the same
 * manual list `createManualAgentSelectionStrategy` renders — one click
 * away, no second dialog. The manual list is composed from that same
 * factory rather than reimplemented, so composer styling and behavior
 * stay identical to the manual-only path.
 */
export function createMyraAgentSelectionStrategy(
  listAgents: (tenantId: string) => Promise<readonly TaskAgentOption[]>,
): AgentSelectionStrategy {
  const ManualStrategy = createManualAgentSelectionStrategy(listAgents);

  return function MyraAgentSelectionStrategy({
    tenantId,
    selectedId,
    onSelect,
    onOptionsResolved,
  }) {
    const [mode, setMode] = useState<"myra" | "manual">(
      selectedId !== null && selectedId !== MYRA_AUTO_SELECTION_ID
        ? "manual"
        : "myra",
    );

    // Fires once per mount, mirroring the manual strategy's own mount
    // effect: "Let Myra choose" is the default, so a person opening the
    // composer fresh (no preseeded selection) gets it selected without
    // a click. A preseeded real agent id (e.g. `initialDefinitionId`
    // from a host) is left alone — it already means "choose yourself."
    useEffect(() => {
      if (selectedId === null) {
        onSelect(MYRA_AUTO_SELECTION_ID);
      }
      // Only ever runs on mount — a person's own later clicks must
      // never be second-guessed by this effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Independent of whether the manual list is visible: the manual
    // ids must reach the dialog's stale-selection reconciliation (see
    // `handleOptionsResolved` in task-composer-dialog.tsx) as soon as
    // they're known, or a fresh "Let Myra choose" default risks being
    // read as a stale remembered agent and cleared. Unioned with the
    // sentinel so `MYRA_AUTO_SELECTION_ID` is always in the resolved
    // set too.
    useEffect(() => {
      let cancelled = false;
      listAgents(tenantId)
        .then((items) => {
          if (cancelled) return;
          onOptionsResolved([
            MYRA_AUTO_SELECTION_ID,
            ...items.map((item) => item.id),
          ]);
        })
        .catch(() => {
          // The manual list itself surfaces the fetch error when
          // expanded (via `ManualStrategy` below) — nothing more to do
          // here, since this effect only exists to unblock resolution.
        });
      return () => {
        cancelled = true;
      };
    }, [tenantId, onOptionsResolved]);

    const chooseMyra = useCallback(() => {
      setMode("myra");
      onSelect(MYRA_AUTO_SELECTION_ID);
    }, [onSelect]);

    const chooseManually = useCallback(() => {
      setMode("manual");
    }, []);

    return (
      <>
        {/* No role="radiogroup" here — the fieldset/legend "Agent" that
            hosts this strategy in task-composer-dialog.tsx already
            provides the group semantics; a second ARIA group nested
            inside it would be redundant. This div exists only for the
            visual gap between the two stacked options. */}
        <div className="tasks-radio-group">
          <label
            className="tasks-radio-option"
            data-testid="new-task-agent-option"
          >
            <input
              type="radio"
              name="task-agent-mode"
              checked={mode === "myra"}
              onChange={chooseMyra}
            />
            <span className="tasks-radio-option-text">
              <span className="tasks-radio-option-title">Let Myra choose</span>
              <span className="tasks-radio-option-desc">
                Myra reads your prompt and picks or creates the right agent.
              </span>
            </span>
          </label>
          <label
            className="tasks-radio-option"
            data-testid="new-task-agent-option"
          >
            <input
              type="radio"
              name="task-agent-mode"
              checked={mode === "manual"}
              onChange={chooseManually}
            />
            <span className="tasks-radio-option-text">
              <span className="tasks-radio-option-title">
                Choose an agent yourself
              </span>
              <span className="tasks-radio-option-desc">
                Pick from your agents and set the prompt yourself.
              </span>
            </span>
          </label>
        </div>
        {mode === "manual" ? (
          <ManualStrategy
            tenantId={tenantId}
            selectedId={selectedId}
            onSelect={onSelect}
            onOptionsResolved={onOptionsResolved}
          />
        ) : null}
      </>
    );
  };
}

/**
 * Presentational only — after a Myra-dispatched task is created,
 * whatever renders the task item (apps/web, not this package) can show
 * what Myra picked. No data fetching here; the host supplies everything
 * and gets a callback back when the person wants the reasoning behind
 * the pick.
 */
export function MyraChoiceSummary({
  agentName,
  tools,
  model,
  plannerRunId,
  onViewPlannerRun,
}: {
  readonly agentName: string;
  readonly tools: readonly string[];
  readonly model: string | null;
  readonly plannerRunId: string;
  readonly onViewPlannerRun: (plannerRunId: string) => void;
}) {
  return (
    <p className="tasks-myra-choice-summary">
      Myra picked <strong>{agentName}</strong>
      {tools.length > 0 ? ` with ${tools.join(", ")}` : ""}
      {model !== null ? ` on ${model}` : ""}.{" "}
      <button
        type="button"
        className="tasks-link-button"
        onClick={() => onViewPlannerRun(plannerRunId)}
      >
        Why this agent?
      </button>
    </p>
  );
}
