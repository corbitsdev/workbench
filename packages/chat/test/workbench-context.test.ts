import { describe, expect, test } from "bun:test";
import {
  buildDroppedRecap,
  renderWorkbenchContext,
} from "../src/workbench-context";

describe("renderWorkbenchContext", () => {
  test("renders a header followed by one line per item, oldest first", () => {
    const text = renderWorkbenchContext({
      items: [
        { label: "@echo", text: "hello" },
        { label: "user", text: "hi there" },
        { label: "@assistant", text: "on it" },
      ],
    });

    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "[Workbench context — the most recent messages in this workbench, oldest " +
        "first. The actual message addressed to you follows after this " +
        "block.]",
    );
    expect(lines.slice(1)).toEqual([
      "@echo: hello",
      "user: hi there",
      "@assistant: on it",
    ]);
  });

  test("truncates a message beyond ~500 chars with an ellipsis", () => {
    const long = "x".repeat(600);
    const text = renderWorkbenchContext({
      items: [{ label: "@echo", text: long }],
    });

    const line = text.split("\n")[1] ?? "";
    expect(line.startsWith("@echo: ")).toBe(true);
    const rendered = line.slice("@echo: ".length);
    expect(rendered.length).toBe(501);
    expect(rendered.endsWith("…")).toBe(true);
    expect(rendered.slice(0, 500)).toBe(long.slice(0, 500));
  });

  test("does not truncate a message at or under the limit", () => {
    const exact = "y".repeat(500);
    const text = renderWorkbenchContext({
      items: [{ label: "user", text: exact }],
    });

    expect(text.split("\n")[1]).toBe(`user: ${exact}`);
  });

  test("renders only the header for an empty item list", () => {
    const text = renderWorkbenchContext({ items: [] });
    expect(text.split("\n")).toHaveLength(1);
  });

  test("caps and ordering are entirely the caller's responsibility: renders exactly the items given, in the given order", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      label: "user",
      text: `msg-${i}`,
    }));
    const text = renderWorkbenchContext({ items });
    expect(text.split("\n")).toHaveLength(26);
  });

  test("agent vs user labels pass through verbatim, never a raw address or id", () => {
    const text = renderWorkbenchContext({
      items: [
        { label: "@echo", text: "agent message" },
        { label: "user", text: "human message" },
      ],
    });
    expect(text).not.toContain("@acme.example");
    expect(text).not.toContain("prn_");
    expect(text).not.toContain("ins_");
    expect(text).toContain("@echo: agent message");
    expect(text).toContain("user: human message");
  });

  test("prepends a given recap line right after the header, ahead of every item", () => {
    const recap = buildDroppedRecap({
      droppedCount: 2,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-02T00:00:00.000Z",
      humanTexts: ["earlier fact one", "earlier fact two"],
    });
    const text = renderWorkbenchContext({
      items: [{ label: "user", text: "the newest kept message" }],
      recap,
    });
    const lines = text.split("\n");
    expect(lines[1]).toBe(`system: ${recap.text}`);
    expect(lines[2]).toBe("user: the newest kept message");
  });
});

describe("buildDroppedRecap", () => {
  test("labels the recap as system, never a real person", () => {
    const recap = buildDroppedRecap({
      droppedCount: 1,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-01T00:00:00.000Z",
      humanTexts: ["hello"],
    });
    expect(recap.label).toBe("system");
  });

  test("names the recap span, count, and dates", () => {
    const recap = buildDroppedRecap({
      droppedCount: 3,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-03T00:00:00.000Z",
      humanTexts: ["fact one", "fact two"],
    });
    expect(recap.text).toContain("Earlier in this conversation");
    expect(recap.text).toContain("3 older messages");
    expect(recap.text).toContain("from 2026-08-01 to 2026-08-03");
  });

  test("folds each human message's first ~100 chars, oldest first", () => {
    const long = "z".repeat(200);
    const recap = buildDroppedRecap({
      droppedCount: 2,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-01T00:00:01.000Z",
      humanTexts: ["short one", long],
    });
    expect(recap.text).toContain("short one");
    expect(recap.text).toContain(long.slice(0, 100));
    expect(recap.text).not.toContain(long.slice(0, 101));
  });

  test("caps the total fold at ~1200 chars, tailing an honest count of what was left out", () => {
    const humanTexts = Array.from({ length: 20 }, (_, i) =>
      `msg-${i}-`.repeat(20),
    );
    const recap = buildDroppedRecap({
      droppedCount: 20,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-01T00:00:20.000Z",
      humanTexts,
    });
    const body = recap.text.slice(recap.text.indexOf("): ") + 3);
    expect(body.length).toBeLessThan(1400);
    expect(recap.text).toMatch(/… and \d+ more/);
  });

  test("never exceeds its cap regardless of how many messages are handed in", () => {
    const humanTexts = Array.from({ length: 500 }, (_, i) =>
      `fact number ${i} `.repeat(10),
    );
    const recap = buildDroppedRecap({
      droppedCount: 500,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-20T00:00:00.000Z",
      humanTexts,
    });
    expect(recap.text.length).toBeLessThan(1600);
  });

  test("an agents-only dropped span still yields an honest count line with no fabricated quotes", () => {
    const recap = buildDroppedRecap({
      droppedCount: 4,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-01T00:00:03.000Z",
      humanTexts: [],
    });
    expect(recap.text).toContain("4 older messages");
    expect(recap.text).not.toMatch(/… and \d+ more/);
    expect(recap.text).toContain("no human messages");
  });

  test("marks the count as a lower bound when more history sits beyond what was even looked at", () => {
    const recap = buildDroppedRecap({
      droppedCount: 60,
      moreBeyondFold: true,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-10T00:00:00.000Z",
      humanTexts: ["fact"],
    });
    expect(recap.text).toContain("60+ older messages");
  });

  test("clearly marks the entry as a recap, not a quote", () => {
    const recap = buildDroppedRecap({
      droppedCount: 1,
      moreBeyondFold: false,
      firstDate: "2026-08-01T00:00:00.000Z",
      lastDate: "2026-08-01T00:00:00.000Z",
      humanTexts: ["fact"],
    });
    expect(recap.text).toMatch(/^Earlier in this conversation/);
  });
});
