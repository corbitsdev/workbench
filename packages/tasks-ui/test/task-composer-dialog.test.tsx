// DOM-mounted render tests for `TaskComposerDialog`: the default
// caller wires `createManualAgentSelectionStrategy` (the manual
// picker), the model select only appears once `listModels` resolves a
// non-empty catalog, `Start task` stays disabled until an agent is
// picked and a prompt is typed, Cmd/Ctrl+Enter in the prompt submits,
// `initialDefinitionId` preselects the agent field, and a stub
// strategy proves the agent-selection seam is real — a future
// programmatic strategy (CL-6050) can be swapped in without touching
// this file. Needs a real DOM (see dom-setup.ts) — Radix's
// `Dialog.Portal` renders nothing under `renderToStaticMarkup`,
// mirroring `packages/chat-ui/test/new-channel-dialog.test.tsx`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { createManualAgentSelectionStrategy } from "../src/agent-selection-strategy";
import type { AgentSelectionStrategy } from "../src/agent-selection-strategy";
import { TaskComposerDialog } from "../src/task-composer-dialog";
import type { CatalogModel } from "../src/api";

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
    agentSelectionStrategy: createManualAgentSelectionStrategy(async () => []),
    listModels: async () => [],
    ...overrides,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TaskComposerDialog", () => {
  test("renders the agents the manual strategy resolves, radio-selectable", async () => {
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot", description: "Incident bot" },
          { id: "wfd_2", name: "digest-bot" },
        ]),
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
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
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

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      setTextareaValue(textarea, "Summarize the incident.");
    });
    await settle();
    expect(submit()?.hasAttribute("disabled")).toBe(false);
  });

  test("submitting calls onCreate with the picked agent and trimmed prompt", async () => {
    let created: unknown;
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
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

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "  Summarize the incident.  ");
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

  test("Cmd/Ctrl+Enter in the prompt submits without a form submit event", async () => {
    let created: unknown;
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
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

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "Summarize the incident.");
    });
    await settle();

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(created).toEqual({
      definitionId: "wfd_1",
      prompt: "Summarize the incident.",
    });
  });

  test("a bare Enter in the prompt does not submit", async () => {
    let created: unknown;
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
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

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "Summarize the incident.");
    });
    await settle();

    act(() => {
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(created).toBeUndefined();
  });

  test("the prompt textarea is focused as soon as the dialog opens", async () => {
    mount(baseProps());
    await settle();

    const textarea = document.body.querySelector("textarea");
    expect(document.activeElement).toBe(textarea);
  });

  test("initialDefinitionId preselects the agent field on open", async () => {
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
          { id: "wfd_2", name: "digest-bot" },
        ]),
        initialDefinitionId: "wfd_2",
      }),
    );
    await settle();

    const radios = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        'input[name="task-agent"]',
      ),
    ];
    expect(radios[0]?.checked).toBe(false);
    expect(radios[1]?.checked).toBe(true);
  });

  test("a remembered agent absent from the resolved list is cleared, never submittable", async () => {
    let created: unknown;
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
        initialDefinitionId: "wfd_deleted",
        onCreate: (input) => {
          created = input;
        },
      }),
    );
    await settle();

    // The stale seed cleared once the list resolved: nothing checked.
    const radios = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        'input[name="task-agent"]',
      ),
    ];
    expect(radios.some((radio) => radio.checked)).toBe(false);

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "Summarize the incident.");
    });
    await settle();

    const submit = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Start task",
    );
    expect(submit?.hasAttribute("disabled")).toBe(true);

    const form = document.body.querySelector("form");
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(created).toBeUndefined();
  });

  test("Cmd/Ctrl+Enter cannot re-fire onCreate while a launch is in flight", async () => {
    let createdCount = 0;
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot" },
        ]),
        submitting: true,
        onCreate: () => {
          createdCount += 1;
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
    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "Summarize the incident.");
    });
    await settle();

    for (let i = 0; i < 3; i++) {
      act(() => {
        textarea?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    await settle();

    expect(createdCount).toBe(0);
  });

  test("the prompt textarea is labeled and the footer has Cancel and Start task", async () => {
    mount(baseProps());
    await settle();

    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea?.id).toBeTruthy();
    const label = document.body.querySelector(`label[for="${textarea?.id}"]`);
    expect(label?.textContent).toBe("Prompt");

    const buttons = [...document.body.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    expect(buttons).toContain("Cancel");
    expect(buttons).toContain("Start task");
  });

  test("the manual agent list renders inside a legend-labeled Agent fieldset, each option its own name and description", async () => {
    mount(
      baseProps({
        agentSelectionStrategy: createManualAgentSelectionStrategy(async () => [
          { id: "wfd_1", name: "incident-bot", description: "Incident bot" },
          { id: "wfd_2", name: "digest-bot" },
        ]),
      }),
    );
    await settle();

    // Group semantics come from the fieldset/legend — the manual list
    // itself carries no redundant nested ARIA group (CL-6066 follow-up).
    const fieldset = document.body.querySelector("fieldset");
    expect(fieldset?.querySelector("legend")?.textContent).toBe("Agent");
    expect(fieldset?.querySelector('[role="radiogroup"]')).toBeNull();

    const radios = fieldset?.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(2);

    const titles = [
      ...document.body.querySelectorAll(".tasks-radio-option-title"),
    ].map((el) => el.textContent);
    expect(titles).toEqual(["incident-bot", "digest-bot"]);
    const descriptions = document.body.querySelectorAll(
      ".tasks-radio-option-desc",
    );
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.textContent).toBe("Incident bot");
  });

  test("the error prop renders as an alert inside the dialog", async () => {
    mount(baseProps({ error: "The task couldn't start. Try again." }));
    await settle();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe("The task couldn't start. Try again.");
  });

  test("an injected strategy stands in for the manual picker — the seam is real", async () => {
    const seen: {
      props: { tenantId: string; selectedId: string | null } | null;
    } = { props: null };
    const stubStrategy: AgentSelectionStrategy = ({
      tenantId,
      selectedId,
      onSelect,
    }) => {
      seen.props = { tenantId, selectedId };
      return createElement(
        "button",
        {
          type: "button",
          "data-testid": "stub-strategy-pick",
          onClick: () => onSelect("wfd_auto"),
        },
        "auto-picked",
      );
    };

    mount(
      baseProps({ agentSelectionStrategy: stubStrategy, tenantId: "tnt_9" }),
    );
    await settle();

    expect(seen.props).toEqual({ tenantId: "tnt_9", selectedId: null });
    expect(
      document.body.querySelector('[data-testid="stub-strategy-pick"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="new-task-agent-option"]'),
    ).toBeNull();

    const pick = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="stub-strategy-pick"]',
    );
    act(() => {
      pick?.click();
    });
    await settle();

    const submit = () =>
      [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Start task",
      );
    const textarea =
      document.body.querySelector<HTMLTextAreaElement>("textarea");
    act(() => {
      setTextareaValue(textarea, "Go");
    });
    await settle();
    expect(submit()?.hasAttribute("disabled")).toBe(false);
  });
});
