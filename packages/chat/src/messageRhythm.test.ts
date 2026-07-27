/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  CHAT_ASSISTANT_BODY,
  CHAT_MARKER_SLOT,
  CHAT_SYSTEM_BUBBLE_SURFACE,
  CHAT_THREAD_PADDING,
  CHAT_THREAD_TURN_GAP,
  CHAT_TRACE_DETAIL_OFFSET,
  CHAT_TRACE_DETAIL_PANEL,
  CHAT_TRACE_ROW,
  CHAT_TURN_STACK,
  CHAT_USER_BUBBLE_SURFACE,
} from "./messageRhythm";

describe("messageRhythm", () => {
  it("keeps trace detail offset aligned to marker column plus standard gutter", () => {
    expect(CHAT_MARKER_SLOT).toContain("w-4");
    expect(CHAT_TRACE_ROW).toContain("gap-3.5");
    expect(CHAT_TRACE_DETAIL_OFFSET).toBe("ml-[30px]");
    expect(CHAT_TRACE_DETAIL_PANEL).toContain(CHAT_TRACE_DETAIL_OFFSET);
    expect(CHAT_TRACE_DETAIL_PANEL).toContain("pl-3.5");
  });

  it("uses the workbench spacing scale for turns, thread, and bubbles", () => {
    expect(CHAT_TURN_STACK).toContain("gap-3.5");
    expect(CHAT_THREAD_TURN_GAP).toBe("gap-5");
    expect(CHAT_THREAD_PADDING).toBe("p-3.5");
    expect(CHAT_USER_BUBBLE_SURFACE).toContain("px-3.5");
    expect(CHAT_USER_BUBBLE_SURFACE).toContain("py-2.5");
    expect(CHAT_SYSTEM_BUBBLE_SURFACE).toContain("px-3.5");
    expect(CHAT_ASSISTANT_BODY).toContain("leading-relaxed");
  });
});
