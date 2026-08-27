// What a turn's tool activity actually renders: mounted for real, asserted
// on the text a reader sees. The standing rule under test is that no
// argument bag or tool result ever reaches the DOM as JSON, in any state.
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  test("a known-provider chip uses brand initials, not a dash", () => {
    const el = mount([
      trace({ name: "slack__post_message", input: { channel: "general" } }),
    ]);
    expect(el.querySelector(".chat-tool-activity-tile")?.textContent).toBe(
      "Sl",
    );
  });

  test("a qualified memory search chip is a layman sentence, not a package path", () => {
    const el = mount([
      trace({
        name: "@corbits/memory-tools/memory:memory_search",
        input: { query: "outbound" },
      }),
    ]);
    expect(el.textContent).toContain("Searched memory");
    expect(el.textContent).not.toContain("@corbits");
    expect(el.textContent).not.toContain("memory-tools");
    expect(el.innerHTML).not.toContain("—");
    expect(el.querySelector('[data-status="success"]')).not.toBeNull();
    expect(el.querySelector(".chat-tool-activity-tile svg")).not.toBeNull();
  });

  test("a local tool still running keeps a status of running and a leading glyph", () => {
    const el = mount([
      trace({
        name: "memory_search",
        input: {},
        status: "running",
      }),
    ]);
    expect(el.querySelector('[data-status="running"]')).not.toBeNull();
    expect(el.innerHTML).not.toContain("—");
    expect(el.querySelector(".chat-tool-activity-tile svg")).not.toBeNull();
  });

  test("a Linear list chip uses the Linear tile and a tensed sentence, never the tautology", () => {
    const el = mount([
      trace({
        name: "@corbits/linear-tools/li:linear_list_recent_issues",
      }),
    ]);
    expect(el.textContent).toContain("Listed recent issues in Linear");
    expect(el.textContent).not.toContain("Linear list recent issues");
    expect(el.querySelector(".chat-tool-activity-tile")?.textContent).toBe(
      "Li",
    );
  });
});

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
  "utf8",
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(
    css,
  );
  return match?.[1] ?? "";
}

describe("tool-activity chip layout", () => {
  test("a long chip ellipsizes against the message column, not a shrink-wrapped cycle", () => {
    const stack = ruleBody(".chat-tool-activity");
    expect(stack).toMatch(/width:\s*100%/);
    expect(stack).toMatch(/min-width:\s*0/);
    expect(stack).toMatch(/max-width:\s*100%/);

    const row = ruleBody(".chat-tool-activity-row");
    expect(row).toMatch(/width:\s*100%/);
    expect(row).toMatch(/min-width:\s*0/);
    expect(row).toMatch(/max-width:\s*100%/);

    const chip = ruleBody(".chat-tool-activity-chip");
    expect(chip).toMatch(/width:\s*fit-content/);
    expect(chip).toMatch(/min-width:\s*0/);
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).not.toMatch(/width:\s*max-content/);

    const phrase = ruleBody(".chat-tool-activity-phrase");
    expect(phrase).toMatch(/overflow:\s*hidden/);
    expect(phrase).toMatch(/text-overflow:\s*ellipsis/);
    expect(phrase).toMatch(/white-space:\s*nowrap/);
    expect(phrase).toMatch(/min-width:\s*0/);
  });
});
