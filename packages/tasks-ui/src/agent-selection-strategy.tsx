// The composer's "Agent" field is an injected strategy, not a
// hardcoded picker — CL-6050 ("Myra auto-dispatch") wants to slot in a
// strategy that resolves an agent programmatically, without reworking
// `TaskComposerDialog`'s own layout, submit, or model-select logic.
// Today's only strategy is `createManualAgentSelectionStrategy`: a
// fetched definition list, click-to-select, exactly what the composer
// already did before this seam existed. The seam is deliberately
// invisible to today's user — there is no "let the agent choose for
// me" affordance anywhere in this package yet.
import { EmptyState, Skeleton } from "@corbits/react-ui";
import type { InvitableDefinition } from "@corbits/chat-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

export type AgentSelectionStrategyProps = {
  readonly tenantId: string;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
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

/** The default, and today's only, strategy: fetch the tenant's
 * invitable definitions and let the person click one. */
export function createManualAgentSelectionStrategy(
  listAgents: (tenantId: string) => Promise<readonly InvitableDefinition[]>,
): AgentSelectionStrategy {
  return function ManualAgentSelectionStrategy({
    tenantId,
    selectedId,
    onSelect,
  }) {
    const [state, setState] = useState<ListState<InvitableDefinition>>({
      kind: "loading",
    });

    useEffect(() => {
      let cancelled = false;
      setState({ kind: "loading" });
      listAgents(tenantId)
        .then((items) => {
          if (!cancelled) setState({ kind: "ready", items });
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
    }, [tenantId]);

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
      <>
        {state.items.map((definition) => (
          <label
            key={definition.id}
            className="tasks-radio-option"
            data-testid="new-task-agent-option"
          >
            <input
              type="radio"
              name="task-agent"
              checked={selectedId === definition.id}
              onChange={() => onSelect(definition.id)}
            />
            {definition.description ?? definition.name}
          </label>
        ))}
      </>
    );
  };
}
