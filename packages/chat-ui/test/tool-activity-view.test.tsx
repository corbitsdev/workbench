// What a turn's tool activity actually renders: mounted for real, asserted
// on the text a reader sees. The standing rule under test is that no
// argument bag or tool result ever reaches the DOM as JSON, in any state.
import { beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ToolTracePart } from "@corbits/chat/parts";
import { toToolActivityRow } from "../src/tool-activity";
import { ToolActivityGroup } from "../src/tool-activity-view";

function trace(part: Partial<ToolTracePart>): ToolTracePart {
  return {
    kind: "tool-trace",
    name: "web_search",
    input: {},
    status: "success",
    ...part,
  } as ToolTracePart;
}

function mount(parts: readonly ToolTracePart[]): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const rows = parts.map((part, index) => toToolActivityRow(part, `k${index}`));
  act(() => {
    root.render(<ToolActivityGroup rows={rows} />);
  });
  return container;
}

function click(element: Element | null) {
  act(() => {
    (element as HTMLElement).click();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ToolActivityGroup", () => {
  test("a successful call reads as a sentence, with no identifier or JSON", () => {
    const el = mount([
      trace({
        name: "slack__post_message",
        input: { channel: "general", text: "shipping now" },
        output: [{ type: "text", text: "delivered" }],
      }),
    ]);
    expect(el.textContent).toContain("Posted a message in Slack #general");
    expect(el.textContent).not.toContain("slack__post_message");
    expect(el.textContent).not.toContain("{");
    expect(el.textContent).not.toContain('"channel"');
  });

  test("detail stays closed until asked for, then shows plain text", () => {
    const el = mount([
      trace({
        name: "web_search",
        input: { query: "bench pricing" },
        output: [{ type: "text", text: "Eight matching pages." }],
      }),
    ]);
    expect(el.textContent).not.toContain("Eight matching pages.");
    click(el.querySelector(".chat-tool-activity-trigger"));
    expect(el.textContent).toContain("Eight matching pages.");
  });

  test("a failed call says so plainly and opens onto the reason", () => {
    const el = mount([
      trace({
        name: "github__get_issue",
        input: { repo: "corbitsdev/workbench" },
        status: "error",
        output: [{ type: "text", text: "Repository not found" }],
      }),
    ]);
    const marker = el.querySelector(".chat-tool-activity-marker");
    expect(marker?.getAttribute("data-status")).toBe("failed");
    click(el.querySelector(".chat-tool-activity-trigger"));
    expect(el.textContent).toContain("Repository not found");
  });

  test("a failure with nothing to say still says that much", () => {
    const el = mount([trace({ name: "run_command", status: "error" })]);
    click(el.querySelector(".chat-tool-activity-trigger"));
    expect(el.textContent).toContain("No reason given.");
  });

  test("a call still running speaks in the present tense and offers no disclosure", () => {
    const el = mount([
      trace({ name: "web_search", input: { query: "x" }, status: "running" }),
    ]);
    expect(el.textContent).toContain('Searching the web for "x"');
    expect(el.querySelector(".chat-tool-activity-trigger")).toBeNull();
    expect(
      el
        .querySelector(".chat-tool-activity-marker")
        ?.getAttribute("data-status"),
    ).toBe("running");
  });

  test("consecutive calls stack as individual chips, never a count", () => {
    const el = mount([
      trace({ name: "web_search", input: { query: "a" } }),
      trace({ name: "read_file", input: { path: "src/app.ts" } }),
      trace({ name: "write_file", input: { path: "src/app.ts" } }),
    ]);
    expect(el.textContent).not.toContain("steps");
    expect(el.textContent).toContain('Searched the web for "a"');
    expect(el.textContent).toContain("Read a file — app.ts");
    expect(el.textContent).toContain("Wrote a file — app.ts");
    expect(el.querySelectorAll(".chat-tool-activity-row").length).toBe(3);
  });

  test("a call still running renders alongside settled calls, not folded", () => {
    const el = mount([
      trace({ name: "read_file", input: { path: "a.ts" } }),
      trace({ name: "web_search", input: { query: "b" }, status: "running" }),
    ]);
    expect(el.textContent).toContain('Searching the web for "b"');
    expect(el.textContent).toContain("Read a file — a.ts");
    expect(el.textContent).not.toContain("2 steps");
  });

  test("a failed call among others names its own failure, on its own chip", () => {
    const el = mount([
      trace({ name: "read_file", input: { path: "a.ts" } }),
      trace({
        name: "github__get_issue",
        status: "error",
        output: "Repository not found",
      }),
    ]);
    expect(el.textContent).not.toContain("didn't work");
    expect(el.textContent).toContain("Retrieved an issue in GitHub");
    const failedRow = el.querySelector('[data-status="failed"]');
    expect(failedRow).not.toBeNull();
    click(failedRow?.querySelector(".chat-tool-activity-trigger") ?? null);
    expect(el.textContent).toContain("Repository not found");
  });

  test("every chip carries a provider tile", () => {
    const el = mount([
      trace({ name: "slack__post_message", input: { channel: "general" } }),
    ]);
    expect(el.querySelector(".chat-tool-activity-tile")?.textContent).toBe(
      "Sl",
    );
  });
});
