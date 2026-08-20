// The composer's "Agent" field is an injected strategy, not a
// hardcoded picker — CL-6050 ("Myra auto-dispatch") wants to slot in a
// strategy that resolves an agent programmatically, without reworking
// `TaskComposerDialog`'s own layout, submit, or model-select logic.
// Today's only strategy is `createManualAgentSelectionStrategy`: a
// fetched agent list, click-to-select, exactly what the composer
// already did before this seam existed. The seam is deliberately
// invisible to today's user — there is no "let the agent choose for
// me" affordance anywhere in this package yet.
import { EmptyState } from "@corbits/react-ui";
import { Users } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";

/**
 * One offerable agent, structurally — the same `{id, name,
 * description?}` shape chat-ui's invitable listing resolves, named
 * here rather than imported so this package carries no dependency on
 * `@corbits/chat-ui`: a host wires whatever listing satisfies it.
 */
export type TaskAgentOption = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
};

export type AgentSelectionStrategyProps = {
  readonly tenantId: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /**
   * Reports the ids this strategy can actually produce, once it knows
   * them (the manual picker calls it when its fetched list resolves).
   * The dialog uses it to reconcile a preseeded selection (the
   * most-recently-used default) against reality — a remembered agent
   * that no longer exists must never ride a submit.
   */
  readonly onOptionsResolved: (ids: readonly string[]) => void;
};

/**
 * Renders the composer's agent-selection surface. Mounted only while
 * the dialog is open (`TaskComposerDialog` renders it conditionally),
 * so a strategy's own effects fire fresh on every open and clean up on
 * close — the same lifecycle the inline picker had before this file
 * existed. A strategy owns how a `definitionId` gets chosen; the
 * dialog only ever reads `selectedId` back and never reaches into a
 * strategy's own internal state.
 */
export type AgentSelectionStrategy = ComponentType<AgentSelectionStrategyProps>;

/** The default, and today's only, strategy: fetch the workbench's
 * offerable agents and let the person click one. */
export function createManualAgentSelectionStrategy(
  listAgents: (tenantId: string) => Promise<readonly TaskAgentOption[]>,
): AgentSelectionStrategy {
  return function ManualAgentSelectionStrategy({
    tenantId,
    selectedId,
    onSelect,
    onOptionsResolved,
  }) {
    const [query, setQuery] = useState<APIQuery<readonly TaskAgentOption[]>>({
      kind: "loading",
    });

    useEffect(() => {
      let cancelled = false;
      setQuery({ kind: "loading" });
      const load = () => {
        listAgents(tenantId)
          .then((items) => {
            if (cancelled) return;
            setQuery({ kind: "ready", data: items });
            onOptionsResolved(items.map((item) => item.id));
          })
          .catch((cause: unknown) => {
            if (cancelled) return;
            if (cause instanceof UnauthenticatedError) {
              setQuery({ kind: "unauthenticated" });
              return;
            }
            setQuery({
              kind: "error",
              message: describeQueryError(cause),
              retry: load,
            });
          });
      };
      load();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId, onOptionsResolved]);

    return (
      <QueryView query={query} label="agents">
        {(items) =>
          items.length === 0 ? (
            <EmptyState
              icon={<Users />}
              title="No agents yet"
              description="Create a workbench to run this before giving it a task."
            />
          ) : (
            // No role="radiogroup" here — the fieldset/legend "Agent" that
            // hosts this strategy in task-composer-dialog.tsx already
            // provides the group semantics; a second ARIA group nested
            // inside it would be redundant. This div exists only for the
            // visual gap between stacked options.
            <div className="tasks-radio-group">
              {items.map((agent) => (
                <label
                  key={agent.id}
                  className="tasks-radio-option"
                  data-testid="new-task-agent-option"
                >
                  <input
                    type="radio"
                    name="task-agent"
                    checked={selectedId === agent.id}
                    onChange={() => onSelect(agent.id)}
                  />
                  <span className="tasks-radio-option-text">
                    <span className="tasks-radio-option-title">
                      {agent.name}
                    </span>
                    {agent.description !== undefined ? (
                      <span className="tasks-radio-option-desc">
                        {agent.description}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )
        }
      </QueryView>
    );
  };
}
