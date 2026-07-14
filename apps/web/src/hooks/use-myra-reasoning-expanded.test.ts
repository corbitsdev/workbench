/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ChatMessage } from "@workbench/chat";
import { STREAMING_BUBBLE_ID } from "@workbench/agents/browser";
import { readReasoningExpanded, writeReasoningExpanded } from "@workbench/chat";
import { useMyraReasoningExpanded } from "./use-myra-reasoning-expanded";

afterEach(() => {
  localStorage.clear();
});

function agent(id: string, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    role: "agent",
    content: "Answer",
    createdAt: "2026-01-01T00:00:00Z",
    reasoning: "Because",
    ...extra,
  };
}

describe("useMyraReasoningExpanded", () => {
  it("persists expand across hook remounts (reload)", () => {
    const messages = [agent("mail-1")];
    const first = renderHook(() => useMyraReasoningExpanded(messages));
    act(() => {
      first.result.current.setReasoningExpanded("mail-1", true);
    });
    first.unmount();

    const second = renderHook(() => useMyraReasoningExpanded(messages));
    expect(second.result.current.isReasoningExpanded("mail-1")).toBe(true);
  });

  it("migrates streaming bubble expand to the settled agent message", () => {
    writeReasoningExpanded(STREAMING_BUBBLE_ID, true);
    const streaming: ChatMessage[] = [
      agent(STREAMING_BUBBLE_ID, {
        content: "",
        status: "sending",
        reasoning: "Live",
      }),
    ];
    const settled: ChatMessage[] = [agent("mail-9", { reasoning: "Live" })];

    const { rerender } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useMyraReasoningExpanded(msgs),
      { initialProps: { msgs: streaming } },
    );
    rerender({ msgs: settled });

    expect(readReasoningExpanded("mail-9")).toBe(true);
    expect(readReasoningExpanded(STREAMING_BUBBLE_ID)).toBe(false);
  });

  it("reconciles expand saved under mail id after reload pins feedbackId to turn id", () => {
    writeReasoningExpanded("mail-a", true);
    const afterReload = [
      agent("mail-a", { feedbackId: "turn-t", reasoning: "Because" }),
    ];
    const { result } = renderHook(() => useMyraReasoningExpanded(afterReload));
    expect(readReasoningExpanded("turn-t")).toBe(true);
    expect(readReasoningExpanded("mail-a")).toBe(false);
    expect(result.current.isReasoningExpanded("turn-t")).toBe(true);
  });

  it("migrates expand when the assistant slot id changes turn → mail live", () => {
    writeReasoningExpanded("turn-t", true);
    const { rerender, result } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useMyraReasoningExpanded(msgs),
      { initialProps: { msgs: [agent("turn-t")] } },
    );
    rerender({
      msgs: [agent("mail-a", { feedbackId: "turn-t", reasoning: "Because" })],
    });
    expect(readReasoningExpanded("turn-t")).toBe(true);
    expect(result.current.isReasoningExpanded("turn-t")).toBe(true);
  });

  it("migrates expand when the slot settles to mail id before feedbackId exists", () => {
    writeReasoningExpanded("turn-t", true);
    const { rerender, result } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useMyraReasoningExpanded(msgs),
      { initialProps: { msgs: [agent("turn-t")] } },
    );
    rerender({ msgs: [agent("mail-a")] });
    expect(readReasoningExpanded("mail-a")).toBe(true);
    expect(result.current.isReasoningExpanded("mail-a")).toBe(true);
  });
});