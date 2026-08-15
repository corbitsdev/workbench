// DOM-mounted render tests for `TaskComposerDialog`: the agent picker
// renders from `listAgents`, the model select only appears once
// `listModels` resolves a non-empty catalog, and `Start task` stays
// disabled until an agent is picked and a prompt is typed. Needs a
// real DOM (see dom-setup.ts) — Radix's `Dialog.Portal` renders
// nothing under `renderToStaticMarkup`, mirroring
// `packages/chat-ui/test/new-channel-dialog.test.tsx`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { TaskComposerDialog } from "./task-composer-dialog";
import type { CatalogModel } from "./api";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof TaskComposerDialog>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(TaskComposerDialog, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function baseProps(
  overrides: Partial<Parameters<typeof TaskComposerDialog>[0]> = {},
): Parameters<typeof TaskComposerDialog>[0] {
  return {
    open: true,
    onOpenChange: () => undefined,
    onCreate: () => undefined,
    tenantId: "tnt_1",
    submitting: false,
    listAgents: async () => [],
    listModels: async () => [],
    ...overrides,
  };
}

describe("TaskComposerDialog", () => {
  test("renders the agents listAgents resolves, radio-selectable", async () => {
    mount(
      baseProps({
        listAgents: async () => [
          { id: "wfd_1", name: "incident-bot", description: "Incident bot" },
          { id: "wfd_2", name: "digest-bot" },
        ],
      }),
    );
    await settle();

    const options = document.body.querySelectorAll(
      '[data-testid="new-task-agent-option"]',
    );
    expect(options).toHaveLength(2);
    expect(document.body.textContent).toContain("Incident bot");
    expect(document.body.textContent).toContain("digest-bot");
  });

  test("the model select is absent when the catalog is empty", async () => {
    mount(baseProps({ listModels: async () => [] }));
    await settle();

    expect(
      document.body.querySelector('[data-testid="new-task-model-select"]'),
    ).toBeNull();
  });

  test("the model select appears once the catalog resolves a non-empty list", async () => {
    const models: readonly CatalogModel[] = [
      {
        id: "mdl_1",
        tenantId: "tnt_1",
        canonicalName: "anthropic/claude-sonnet",
        displayName: "Claude Sonnet",
        disabled: false,
      },
    ];
    mount(baseProps({ listModels: async () => models }));
    await settle();

    const select = document.body.querySelector(
      '[data-testid="new-task-model-select"]',
    );
    expect(select).not.toBeNull();
    expect(select?.textContent).toContain("Claude Sonnet");
  });

  test("Start task stays disabled until an agent is picked and a prompt is typed", async () => {
    mount(
      baseProps({
        listAgents: async () => [{ id: "wfd_1", name: "incident-bot" }],
      }),
    );
    await settle();

    const submit = () =>
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Start task",
      );
    expect(submit()?.hasAttribute("disabled")).toBe(true);

    const radio = document.body.querySelector<HTMLInputElement>(
      'input[name="task-agent"]',
    );
    expect(radio).not.toBeNull();
    act(() => {
      radio?.click();
    });
    await settle();
    expect(submit()?.hasAttribute("disabled")).toBe(true);

    const textarea = document.body.querySelector("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Summarize the incident.");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(submit()?.hasAttribute("disabled")).toBe(false);
  });

  test("submitting calls onCreate with the picked agent and trimmed prompt", async () => {
    let created: unknown;
    mount(
      baseProps({
        listAgents: async () => [{ id: "wfd_1", name: "incident-bot" }],
        onCreate: (input) => {
          created = input;
        },
      }),
    );
    await settle();

    const radio = document.body.querySelector<HTMLInputElement>(
      'input[name="task-agent"]',
    );
    act(() => {
      radio?.click();
    });
    await settle();

    const textarea = document.body.querySelector("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "  Summarize the incident.  ");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const form = document.body.querySelector("form");
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(created).toEqual({
      definitionId: "wfd_1",
      prompt: "Summarize the incident.",
    });
  });
});
