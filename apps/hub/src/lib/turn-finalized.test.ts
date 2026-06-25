import { describe, it, expect, mock } from "bun:test";

// The onTurnFinalized callback is defined inline in index.ts. This test
// verifies the dispatch shape by exercising the same logic in isolation.

type TurnSummary = {
  turnId: string;
  status: string;
  text: string;
  hadReply: boolean;
  hadError: boolean;
  errors: unknown[];
  toolCalls: unknown[];
  toolErrors: unknown[];
};

function createOnTurnFinalized(
  dispatchAgentEvent: (
    agentAddress: string,
    event: { type: string; data: unknown },
  ) => void,
) {
  return function onTurnFinalized(agentAddress: string, turn: TurnSummary) {
    dispatchAgentEvent(agentAddress, {
      type: "turn.committed",
      data: {
        turnId: turn.turnId,
        status: turn.status,
        text: turn.text,
        hadReply: turn.hadReply,
        hadError: turn.hadError,
        errors: turn.errors,
        toolCalls: turn.toolCalls,
        toolErrors: turn.toolErrors,
      },
    });
  };
}

describe("onTurnFinalized", () => {
  it("dispatches turn.committed event to sidecarRouter with full turn payload", () => {
    const dispatch = mock(() => {});
    const onTurnFinalized = createOnTurnFinalized(dispatch);

    const turn: TurnSummary = {
      turnId: "turn-123",
      status: "completed",
      text: "Hello",
      hadReply: true,
      hadError: false,
      errors: [],
      toolCalls: [{ name: "read_file" }],
      toolErrors: [],
    };

    onTurnFinalized("agent@tenant.localhost", turn);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("agent@tenant.localhost", {
      type: "turn.committed",
      data: {
        turnId: "turn-123",
        status: "completed",
        text: "Hello",
        hadReply: true,
        hadError: false,
        errors: [],
        toolCalls: [{ name: "read_file" }],
        toolErrors: [],
      },
    });
  });

  it("dispatches to the correct agent address", () => {
    const dispatch = mock(() => {});
    const onTurnFinalized = createOnTurnFinalized(dispatch);

    const turn: TurnSummary = {
      turnId: "turn-456",
      status: "error",
      text: "",
      hadReply: false,
      hadError: true,
      errors: [{ message: "timeout" }],
      toolCalls: [],
      toolErrors: [{ name: "write_file", error: "permission denied" }],
    };

    onTurnFinalized("other-agent@other-tenant.localhost", turn);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const firstCallArgs = (
      dispatch.mock.calls as unknown as [string, unknown][]
    )[0]!;
    expect(firstCallArgs[0]).toBe("other-agent@other-tenant.localhost");
  });
});
