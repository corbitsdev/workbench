/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

// The comparison block dispatches to @workbench/ui's ComparisonView, which uses
// framer-motion — not Happy DOM-compatible. Replace motion.* with plain
// elements so the grid renders in the test runtime.
const MOTION_ONLY = new Set([
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "layout",
]);
mock.module("framer-motion", () => ({
  motion: new Proxy(
    {},
    {
      get(_t, tag: string) {
        return ({
          children,
          ...rest
        }: {
          children?: React.ReactNode;
          [key: string]: unknown;
        }) => {
          const domProps: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rest)) {
            if (!MOTION_ONLY.has(key)) domProps[key] = value;
          }
          return React.createElement(tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useReducedMotion: () => false,
}));

import { UIBlockView } from "./UIBlockView";
import type { UIBlock, UIResponse } from "./ui-block";

afterEach(() => {
  cleanup();
});

describe("UIBlockView", () => {
  it("renders a document title and reveals the source when opened", () => {
    const block: UIBlock = {
      kind: "document",
      title: "ABK | Book a Demo",
      subtitle: "granola note · Jun 10",
      source: "# Call: ABK\nSummary here",
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("ABK | Book a Demo")).not.toBeNull();
    // Collapsed by default: body not shown.
    expect(screen.queryByText("Summary here")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /ABK | Book a Demo/ }));
    expect(screen.getByText("Summary here")).not.toBeNull();
  });

  it("renders a table with its columns and cells", () => {
    const block: UIBlock = {
      kind: "table",
      columns: ["Pain point", "Severity"],
      rows: [["Agent degradation", "high"]],
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Pain point")).not.toBeNull();
    expect(screen.getByText("Agent degradation")).not.toBeNull();
  });

  it("fires onRespond with the selected value when a choice is clicked", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      prompt: "Which call?",
      options: [
        { id: "a", label: "ABK Demo", value: "ABK | Book a Demo" },
        { id: "b", label: "Pricing call" },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "ABK Demo" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "ABK | Book a Demo",
    });
  });

  it("falls back to the option label when a choice has no explicit value", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "b", label: "Pricing call" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Pricing call" }));
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "Pricing call",
    });
  });

  it("carries the gate signalName in the response when the choice is a gate", () => {
    const onRespond = mock(() => undefined);
    const block: UIBlock = {
      kind: "choice",
      prompt: "This run is waiting for your input.",
      signalName: "review-draft",
      options: [{ id: "continue", label: "Continue", value: "" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onRespond).toHaveBeenCalledWith({
      blockKind: "choice",
      value: "",
      signalName: "review-draft",
    });
  });

  it("forwards an option's structured payload verbatim in the response (CL-2683)", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const payload = { ranking: [{ rank: 1, label: "Variant 2" }] };
    const block: UIBlock = {
      kind: "choice",
      prompt: "Pick the winning variant.",
      signalName: "ab-decision",
      options: [
        {
          id: "Variant 2",
          label: "Variant 2 wins",
          value: "Variant 2",
          payload,
        },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Variant 2 wins" }));
    expect(received).toEqual({
      blockKind: "choice",
      value: "Variant 2",
      signalName: "ab-decision",
      payload,
    });
  });

  it("folds the prompt-box free text into the selected option's payload (CL-2683)", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const block: UIBlock = {
      kind: "choice",
      prompt: "Pick the winning variant.",
      signalName: "ab-decision",
      promptBox: { placeholder: "Why did it win?", payloadKey: "rationale" },
      options: [
        {
          id: "Variant 2",
          label: "Variant 2 wins",
          value: "Variant 2",
          payload: { ranking: [{ rank: 1, label: "Variant 2" }] },
        },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.change(screen.getByPlaceholderText("Why did it win?"), {
      target: { value: "Punchier." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Variant 2 wins" }));
    expect(received?.payload).toEqual({
      ranking: [{ rank: 1, label: "Variant 2" }],
      rationale: "Punchier.",
    });
  });

  it("grows the form textarea to fit its content as the user types (CL-3234)", () => {
    const block: UIBlock = {
      kind: "form",
      signalName: "intake",
      fields: [{ kind: "textarea", name: "focus", label: "Focus" }],
    };
    render(<UIBlockView block={block} />);
    const area = screen.getByRole("textbox", {
      name: /Focus/,
    }) as HTMLTextAreaElement;
    // Simulate the browser reporting a taller content box than the initial rows.
    Object.defineProperty(area, "scrollHeight", {
      configurable: true,
      get: () => 128,
    });
    fireEvent.change(area, {
      target: { value: "line\nline\nline\nline\nline" },
    });
    // Auto-grow pins the inline height to the measured content height, rather
    // than leaving the box at its fixed initial rows.
    expect(area.style.height).toBe("128px");
  });

  it("caps the textarea height and scrolls past the ceiling (CL-3234)", () => {
    const block: UIBlock = {
      kind: "form",
      signalName: "intake",
      fields: [{ kind: "textarea", name: "focus", label: "Focus" }],
    };
    render(<UIBlockView block={block} />);
    const area = screen.getByRole("textbox", {
      name: /Focus/,
    }) as HTMLTextAreaElement;
    expect(area.className).toContain("max-h-[40vh]");
    expect(area.className).toContain("overflow-y-auto");
    // A min-height floor keeps an empty box at its initial rows rather than
    // collapsing to a single line when auto-grow measures the content. Derived
    // from the shared text-sm line height (1.25rem), py-2 (1rem), 1px border.
    expect(area.style.minHeight).toBe("calc(3 * 1.25rem + 1rem + 2px)");
  });

  it("remeasures height when the textarea width changes (CL-3234)", () => {
    const observers: Array<() => void> = [];
    const original = globalThis.ResizeObserver;
    class FakeResizeObserver {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    }
    globalThis.ResizeObserver =
      FakeResizeObserver as unknown as typeof ResizeObserver;
    try {
      const block: UIBlock = {
        kind: "form",
        signalName: "intake",
        fields: [{ kind: "textarea", name: "focus", label: "Focus" }],
      };
      let height = 40;
      let width = 300;
      render(<UIBlockView block={block} />);
      const area = screen.getByRole("textbox", {
        name: /Focus/,
      }) as HTMLTextAreaElement;
      Object.defineProperty(area, "scrollHeight", {
        configurable: true,
        get: () => height,
      });
      Object.defineProperty(area, "clientWidth", {
        configurable: true,
        get: () => width,
      });
      // A width change (container resize) rewraps text into a taller box.
      width = 150;
      height = 96;
      observers.forEach((fire) => fire());
      expect(area.style.height).toBe("96px");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it("leaves the payload unchanged when the prompt-box is left blank", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const payload = { ranking: [{ rank: 1, label: "Variant 2" }] };
    const block: UIBlock = {
      kind: "choice",
      signalName: "ab-decision",
      promptBox: { placeholder: "Why did it win?", payloadKey: "rationale" },
      options: [{ id: "Variant 2", label: "Variant 2 wins", payload }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Variant 2 wins" }));
    expect(received?.payload).toEqual(payload);
  });

  it("disables submit until a required prompt-box note is entered (CL-2730)", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const block: UIBlock = {
      kind: "choice",
      prompt: "Refine the draft.",
      signalName: "preview-1",
      promptBox: {
        placeholder: "What should change?",
        payloadKey: "feedback",
        required: true,
      },
      options: [
        {
          id: "refine",
          label: "Refine with notes",
          value: "refine",
          payload: { approved: false },
        },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    const button = screen.getByRole("button", { name: "Refine with notes" });
    // Held while the required note is empty: clicking does nothing.
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(received).toBeUndefined();
    // A whitespace-only note does not satisfy the trim guard.
    fireEvent.change(screen.getByPlaceholderText("What should change?"), {
      target: { value: "   " },
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // A real note unlocks submission and folds under the payload key.
    fireEvent.change(screen.getByPlaceholderText("What should change?"), {
      target: { value: "Tighten the opening." },
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(received?.payload).toEqual({
      approved: false,
      feedback: "Tighten the opening.",
    });
  });

  it("submits freely when the prompt-box is not required (CL-2730)", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const block: UIBlock = {
      kind: "choice",
      signalName: "ab-decision",
      // ab-compare's rationale box: optional, must never gate the pick.
      promptBox: { placeholder: "Why did it win?", payloadKey: "rationale" },
      options: [
        {
          id: "Variant 2",
          label: "Variant 2 wins",
          value: "Variant 2",
          payload: { ranking: [{ rank: 1, label: "Variant 2" }] },
        },
      ],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    const button = screen.getByRole("button", { name: "Variant 2 wins" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    expect(received?.value).toBe("Variant 2");
    expect(received?.payload).toEqual({
      ranking: [{ rank: 1, label: "Variant 2" }],
    });
  });

  it("marks an awaiting step with a non-action (blue) status token, not orange", () => {
    const block: UIBlock = {
      kind: "progress",
      steps: [{ state: "awaiting", label: "Decide" }],
    };
    const { container } = render(<UIBlockView block={block} />);
    const indicator = container.querySelector('[data-state="awaiting"] span');
    expect(indicator?.className).toContain("border-blue");
    expect(indicator?.className).not.toContain("border-orange");
  });

  it("omits payload from the response when the option has none", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "a", label: "Yes" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(received?.payload).toBeUndefined();
  });

  it("omits signalName from the response for a non-gate choice", () => {
    let received: UIResponse | undefined;
    const onRespond = (response: UIResponse) => {
      received = response;
    };
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "a", label: "Yes" }],
    };
    render(<UIBlockView block={block} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(received).toEqual({ blockKind: "choice", value: "Yes" });
    expect(received?.signalName).toBeUndefined();
  });

  it("renders an error block message", () => {
    const block: UIBlock = { kind: "error", message: "Granola API failed" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Granola API failed")).not.toBeNull();
  });

  it("renders a plain text block as preformatted prose", () => {
    const block: UIBlock = { kind: "text", text: "just some output" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("just some output")).not.toBeNull();
  });

  it("renders a non-collapsible markdown block open with its source", () => {
    const block: UIBlock = {
      kind: "markdown",
      title: "Notes",
      source: "rendered body",
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Notes")).not.toBeNull();
    expect(screen.getByText("rendered body")).not.toBeNull();
  });

  it("keeps a collapsible markdown block closed until its header is clicked", () => {
    const block: UIBlock = {
      kind: "markdown",
      title: "Details",
      source: "hidden body",
      collapsible: true,
    };
    render(<UIBlockView block={block} />);
    expect(screen.queryByText("hidden body")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText("hidden body")).not.toBeNull();
  });

  it("renders a link block pointing at its url and showing its title", () => {
    const block: UIBlock = {
      kind: "link",
      url: "https://corbits.dev/report",
      title: "Quarterly report",
      description: "Q2 summary",
    };
    const { container } = render(<UIBlockView block={block} />);
    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("https://corbits.dev/report");
    expect(screen.getByText("Quarterly report")).not.toBeNull();
    expect(screen.getByText("Q2 summary")).not.toBeNull();
  });

  it("falls back to the url as the link label when no title is given", () => {
    const block: UIBlock = { kind: "link", url: "https://corbits.dev/raw" };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("https://corbits.dev/raw")).not.toBeNull();
  });

  it("fires onAction with the document action key when an action button is clicked", () => {
    const onAction = mock(() => undefined);
    const block: UIBlock = {
      kind: "document",
      title: "Doc",
      source: "# body text",
      actions: { copy: true, download: true, saveArtifact: true },
    };
    render(<UIBlockView block={block} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: /Doc/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save to artifacts" }));
    expect(onAction).toHaveBeenCalledWith("save-artifact", block);
  });

  it("renders each progress step state distinctly", () => {
    const block: UIBlock = {
      kind: "progress",
      title: "Call collateral",
      steps: [
        { label: "Fetch calls", state: "done" },
        { label: "Draft", state: "running", meta: "step 2 of 5" },
        { label: "Publish", state: "pending" },
      ],
    };
    const { container } = render(<UIBlockView block={block} />);
    expect(screen.getByText("Call collateral")).not.toBeNull();
    expect(container.querySelector("ol")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(3);
    expect(items[0]?.getAttribute("data-state")).toBe("done");
    expect(items[1]?.getAttribute("data-state")).toBe("running");
    expect(items[2]?.getAttribute("data-state")).toBe("pending");
    expect(screen.getByText("Fetch calls")).not.toBeNull();
    expect(screen.getByText("step 2 of 5")).not.toBeNull();
    expect(screen.getByText("done")).not.toBeNull();
    expect(screen.getByText("running")).not.toBeNull();
    expect(screen.getByText("pending")).not.toBeNull();
  });

  it("renders an awaiting step as awaiting input", () => {
    const block: UIBlock = {
      kind: "progress",
      steps: [
        { label: "Draft", state: "done" },
        { label: "Approve draft", state: "awaiting" },
        { label: "Publish", state: "pending" },
      ],
    };
    render(<UIBlockView block={block} />);
    const items = screen.getAllByRole("listitem");
    expect(items[1]?.getAttribute("data-state")).toBe("awaiting");
    expect(screen.getByText("awaiting input")).not.toBeNull();
  });

  it("renders a failed step with its failure state", () => {
    const block: UIBlock = {
      kind: "progress",
      steps: [
        { label: "Fetch", state: "done" },
        { label: "Draft", state: "failed" },
      ],
    };
    render(<UIBlockView block={block} />);
    const items = screen.getAllByRole("listitem");
    expect(items[1]?.getAttribute("data-state")).toBe("failed");
    expect(screen.getByText("failed")).not.toBeNull();
  });

  it("treats a stale non-terminal step as done once a later step has started", () => {
    // Mirrors workflow-run-state.tsx: an awaitSignal gate's completion can be
    // absent from the emitted state, so a later step's progress marks it passed.
    const block: UIBlock = {
      kind: "progress",
      steps: [
        { label: "Approve draft", state: "awaiting" },
        { label: "Publish", state: "running" },
      ],
    };
    render(<UIBlockView block={block} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("done");
    expect(items[1]?.getAttribute("data-state")).toBe("running");
  });

  it("never re-labels a failed step done when a later branch has progressed", () => {
    const block: UIBlock = {
      kind: "progress",
      steps: [
        { label: "Fetch", state: "failed" },
        { label: "Draft", state: "running" },
      ],
    };
    render(<UIBlockView block={block} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("failed");
  });

  it("does not promote an earlier non-terminal step when a later step failed", () => {
    // CL-2654: a later failure says nothing about whether this step completed
    // — the gate must stay awaiting, not flip to done.
    const block: UIBlock = {
      kind: "progress",
      steps: [
        { label: "Approve draft", state: "awaiting" },
        { label: "Publish", state: "failed" },
      ],
    };
    render(<UIBlockView block={block} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("awaiting");
    expect(items[1]?.getAttribute("data-state")).toBe("failed");
  });

  it("recursively renders canvas children", () => {
    const block: UIBlock = {
      kind: "canvas",
      title: "Last call",
      blocks: [
        { kind: "document", title: "Doc", source: "# x" },
        { kind: "choice", options: [{ id: "a", label: "Draft follow-up" }] },
      ],
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Doc")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Draft follow-up" }),
    ).not.toBeNull();
  });

  it("dispatches a comparison block to the comparison grid", () => {
    const block: UIBlock = {
      kind: "comparison",
      status: "final",
      blind: false,
      result: {
        ranking: [{ rank: 1, label: "Variant 1" }],
        variants: [
          {
            label: "Variant 1",
            content: "Winning body text.",
            status: "responded",
          },
        ],
      },
    };
    render(<UIBlockView block={block} />);
    expect(screen.getByText("Winning body text.")).not.toBeNull();
  });

  it("gives choice option buttons the active-press affordance", () => {
    const block: UIBlock = {
      kind: "choice",
      options: [{ id: "a", label: "Variant 1 wins" }],
    };
    render(<UIBlockView block={block} />);
    const button = screen.getByRole("button", { name: "Variant 1 wins" });
    expect(button.className).toContain("active:scale");
  });
});
