// The composer's "Agent" field is an injected strategy, not a
// hardcoded picker — CL-6050 ("Myra auto-dispatch") wants to slot in a
// strategy that resolves an agent programmatically, without reworking
// `TaskComposerDialog`'s own layout, submit, or model-select logic.
// Today's only strategy is `createManualAgentSelectionStrategy`: a
// fetched agent list, click-to-select, exactly what the composer
// already did before this seam existed. The seam is deliberately
// invisible to today's user — there is no "let the agent choose for
// me" affordance anywhere in this package yet.
import { EmptyState, Skeleton } from "@corbits/react-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

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

type ListState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly T[] };

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
    const [state, setState] = useState<ListState<TaskAgentOption>>({
      kind: "loading",
    });

    useEffect(() => {
      let cancelled = false;
      setState({ kind: "loading" });
      listAgents(tenantId)
        .then((items) => {
          if (cancelled) return;
          setState({ kind: "ready", items });
          onOptionsResolved(items.map((item) => item.id));
        })
        .catch((cause: unknown) => {
          if (!cancelled) {
            setState({
              kind: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        });
      return () => {
        cancelled = true;
      };
    }, [tenantId, onOptionsResolved]);

    if (state.kind === "loading") {
      return <Skeleton className="query-skeleton" />;
    }
    if (state.kind === "error") {
      return (
        <EmptyState
          icon={<CircleAlert />}
          title="Couldn't load agents"
          description={state.message}
        />
      );
    }
    if (state.items.length === 0) {
      return (
        <EmptyState
          icon={<Users />}
          title="No agents yet"
          description="Create an agent before giving it a task."
        />
      );
    }
    return (
      <div role="radiogroup" aria-label="Agent" className="tasks-radio-group">
        {state.items.map((agent) => (
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
                {agent.description ?? agent.name}
              </span>
            </span>
          </label>
        ))}
      </div>
    );
  };
}
