import { describe, expect, test } from "bun:test";
import { toReactUiToolTrace, toReactUiReasoning } from "./agent-part-adapter";

describe("toReactUiToolTrace (CL-6318: chat's 4 statuses onto react-ui's 6)", () => {
  const base = {
    kind: "tool-trace" as const,
    name: "slack__post",
    input: { a: 1 },
  };

  test("success is react-ui's output-available, the state that carries a result", () => {
    const adapted = toReactUiToolTrace({
      ...base,
      status: "success",
      output: "ok",
    });
    expect(adapted.status).toBe("output-available");
    expect(adapted.output).toBe("ok");
  });

  test("pending, running and error carry across unchanged", () => {
    for (const status of ["pending", "running", "error"] as const) {
      expect(toReactUiToolTrace({ ...base, status }).status).toBe(status);
    }
  });

  test("name and input ride along so the expanded detail can show them", () => {
    const adapted = toReactUiToolTrace({ ...base, status: "running" });
    expect(adapted.name).toBe("slack__post");
    expect(adapted.input).toEqual({ a: 1 });
  });

  test("the caller's message-scoped key becomes the toolCallId", () => {
    // react-ui keys tool calls by id; chat's wire has no such field, so a
    // key the caller already guarantees unique stands in rather than an
    // invented id that could collide across messages.
    const adapted = toReactUiToolTrace(
      { ...base, status: "running" },
      "msg_1-3",
    );
    expect(adapted.toolCallId).toBe("msg_1-3");
  });

  test("output stays absent when the wire carried none", () => {
    expect("output" in toReactUiToolTrace({ ...base, status: "running" })).toBe(
      false,
    );
  });

  // The two approval states have no `@corbits/chat` equivalent — approvals
  // ride as a `block` part bound to the real approvals flow, not as a tool
  // status. Nothing should silently map onto them.
  test("no chat status maps onto the approval states", () => {
    const reachable = (["pending", "running", "success", "error"] as const).map(
      (status) => toReactUiToolTrace({ ...base, status }).status,
    );
    expect(reachable).not.toContain("approval-requested");
    expect(reachable).not.toContain("output-denied");
  });
});

describe("toReactUiReasoning", () => {
  test("carries the text through", () => {
    expect(toReactUiReasoning({ kind: "reasoning", text: "thinking" })).toEqual(
      {
        kind: "reasoning",
        text: "thinking",
      },
    );
  });

  // chat's ReasoningPart has no duration field; react-ui's is optional, so
  // it stays absent rather than being fabricated as 0.
  test("omits durationMs entirely rather than inventing a zero", () => {
    expect(
      "durationMs" in toReactUiReasoning({ kind: "reasoning", text: "x" }),
    ).toBe(false);
  });
});
