// Persist a routine fire's terminal status onto `workflow_run` once the
// fire has actually finished. Warm-keep (CL-6681) leaves a folded delivery
// agent deployed, so the platform never settles `workflow_run.status` on
// its own; Insights and Mission Control then read a finished fire as
// "Running now" forever. `markTerminal` is the one write that stamps
// `completed`/`failed`/`cancelled` and `endedAt` in a single shot — the
// same store method the hub already uses for native workflow runs.
//
// Only a row in `routine_run` is a fire. A workbench host or invited
// agent is also a folded run; marking those terminal would lie about
// their lifecycle. The port's `isRoutineFire` is that gate.

export type RoutineFireSettleStatus = "completed" | "failed" | "cancelled";

export type RoutineFireSettlePort = {
  isRoutineFire(runId: string): Promise<boolean>;
  markTerminal(
    runId: string,
    status: RoutineFireSettleStatus,
    endedAt: Date,
  ): Promise<unknown | null>;
};

export type RoutineFireTurnSettlePort = RoutineFireSettlePort & {
  lookupRunByAddress(address: string): Promise<{ id: string } | undefined>;
};

/**
 * Stamp a routine fire terminal. Returns whether this caller won the
 * flip (`markTerminal` is single-shot: a later call against an already
 * terminal row returns null). A run that is not a routine fire is a
 * no-op, never a persist.
 */
export async function settleRoutineFire(
  port: RoutineFireSettlePort,
  input: {
    runId: string;
    status: RoutineFireSettleStatus;
    endedAt?: Date;
  },
): Promise<boolean> {
  if (!(await port.isRoutineFire(input.runId))) return false;
  const won = await port.markTerminal(
    input.runId,
    input.status,
    input.endedAt ?? new Date(),
  );
  return won !== null;
}

/**
 * `settleRoutineFire` from a finalized turn: look the run up by the
 * turn's agent address, then persist the turn's own terminal status.
 *
 * Intermediate tool-use steps finalize as `completed` with `hadReply:
 * false`. Those must not stamp the fire — `markTerminal` is single-shot,
 * so an early completed would hide a later failure. A real reply
 * (`hadReply: true`) or a failed turn settles immediately.
 */
export async function settleRoutineFireFromTurn(
  port: RoutineFireTurnSettlePort,
  address: string,
  turn: { readonly status: "completed" | "failed"; readonly hadReply: boolean },
  endedAt: Date = new Date(),
): Promise<boolean> {
  if (turn.status === "completed" && !turn.hadReply) return false;
  const run = await port.lookupRunByAddress(address);
  if (run === undefined) return false;
  return settleRoutineFire(port, {
    runId: run.id,
    status: turn.status,
    endedAt,
  });
}
