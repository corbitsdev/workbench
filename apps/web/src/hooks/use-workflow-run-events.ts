import { useEffect, useRef, useState } from "react";
import { useConversationWorkflowRuns } from "./use-workflow";
import { deriveRunEvents, type WorkflowRunEvent } from "../lib/run-events";
import type { ConversationWorkflowRun } from "./use-workflow";

type RunStatus = ConversationWorkflowRun["status"];

interface Accumulator {
  conversationId: string | null;
  statuses: Map<string, RunStatus>;
  counter: number;
  seeded: boolean;
}

function freshAccumulator(conversationId: string | null): Accumulator {
  return {
    conversationId,
    statuses: new Map(),
    counter: 0,
    seeded: false,
  };
}

/**
 * Run-addressed workflow events for the open conversation (CL-2682), derived
 * entirely from the run records the dock already polls — the SAME shared query
 * (`useConversationWorkflowRuns`), never a second request or a new backend event
 * stream. Each poll is folded against the previous per-run status baseline into
 * append-only transition events (started / progressed / gate-awaiting /
 * completed / failed); the first poll of a conversation seeds the baseline
 * silently so a reload does not replay old history.
 *
 * Accumulating an event log from a changing external source is the legitimate
 * use of an effect here: the events are not derivable from the latest snapshot
 * alone (they encode history), so they are synced out of the poll as it lands.
 */
export function useWorkflowRunEvents(
  conversationId: string | null,
  tenantId?: string | null,
): WorkflowRunEvent[] {
  const { data: runs } = useConversationWorkflowRuns(conversationId, tenantId);
  const accRef = useRef<Accumulator>(freshAccumulator(conversationId));
  // Append-only within a conversation: grows with the number of transitions over
  // the conversation's lifetime, bounded the same way the message list is (and
  // reset when the conversation changes). No hard cap — a known tradeoff.
  const [events, setEvents] = useState<WorkflowRunEvent[]>([]);

  useEffect(() => {
    if (accRef.current.conversationId !== conversationId) {
      accRef.current = freshAccumulator(conversationId);
      setEvents([]);
    }
    if (runs === undefined) return;

    const acc = accRef.current;
    const {
      events: derived,
      next,
      counter,
    } = deriveRunEvents({
      previous: acc.statuses,
      runs,
      now: new Date().toISOString(),
      counter: acc.counter,
      seed: !acc.seeded,
    });
    acc.statuses = next;
    acc.counter = counter;
    acc.seeded = true;

    if (derived.length > 0) {
      setEvents((prev) => [...prev, ...derived]);
    }
  }, [runs, conversationId]);

  return events;
}
