import type {
  UsageByPersonRow,
  UsageByWorkflowTypeRow,
} from "../../lib/hub-api";

/** Actor-kind filter for the person-scoped views. */
export type ActorFilter = "all" | "me" | "others";

export type WorkflowKindRow = {
  kind: string;
  runs: number;
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
};

/**
 * Merges the per-kind run counts (`workflowRuns.byKind`) with the per-kind
 * inference usage (`byWorkflowType`) into one row per kind. Run counts and
 * usage come from two different joins, so a kind can appear in one and not the
 * other; the merge keeps every kind seen in either, zero-filling the missing
 * side. Exported for tests.
 */
export function mergeWorkflowKindRows(
  byKind: { key: string; count: number }[],
  byType: UsageByWorkflowTypeRow[],
): WorkflowKindRow[] {
  const usage = new Map(byType.map((row) => [row.kind, row]));
  const runs = new Map(byKind.map((row) => [row.key, row.count]));
  const kinds = new Set<string>([...runs.keys(), ...usage.keys()]);
  return [...kinds].map((kind) => {
    const u = usage.get(kind);
    return {
      kind,
      runs: runs.get(kind) ?? 0,
      turnCount: u?.turnCount ?? 0,
      toolCallCount: u?.toolCallCount ?? 0,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadTokens ?? 0,
      cacheWriteTokens: u?.cacheWriteTokens ?? 0,
      thinkingTokens: u?.thinkingTokens ?? 0,
    };
  });
}

export function filterPeople(
  people: UsageByPersonRow[],
  filter: ActorFilter,
): UsageByPersonRow[] {
  if (filter === "me") return people.filter((p) => p.isSelf);
  if (filter === "others") return people.filter((p) => !p.isSelf);
  return people;
}
