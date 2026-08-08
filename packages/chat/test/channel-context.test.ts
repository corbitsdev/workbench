import { describe, expect, test } from "bun:test";
import { renderChannelContext } from "../src/channel-context";

describe("renderChannelContext", () => {
  test("renders a header followed by one line per item, oldest first", () => {
    const text = renderChannelContext({
      items: [
        { label: "@echo", text: "hello" },
        { label: "user", text: "hi there" },
        { label: "@assistant", text: "on it" },
      ],
    });

    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "[Channel context — the most recent messages in this channel, oldest " +
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
    const text = renderChannelContext({
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
    const text = renderChannelContext({
      items: [{ label: "user", text: exact }],
    });

    expect(text.split("\n")[1]).toBe(`user: ${exact}`);
  });

  test("renders only the header for an empty item list", () => {
    const text = renderChannelContext({ items: [] });
    expect(text.split("\n")).toHaveLength(1);
  });

  test("caps and ordering are entirely the caller's responsibility: renders exactly the items given, in the given order", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      label: "user",
      text: `msg-${i}`,
    }));
    const text = renderChannelContext({ items });
    expect(text.split("\n")).toHaveLength(26);
  });

  test("agent vs user labels pass through verbatim, never a raw address or id", () => {
    const text = renderChannelContext({
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
});
