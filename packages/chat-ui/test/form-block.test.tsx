// DOM tests for the form card's live round-trip: required-field validation
// blocks submit, a successful submit locks the form into a "Submitted"
// state read back from the port (never from the values still sitting in
// local state), and "Edit response" lets a resubmit overwrite the stored
// row — upsert, not a second submission.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  BlockResponseActions,
  BlockResponseQuery,
} from "../src/blocks/block-responses";
import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";

function messageWithFormBlock(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "block",
          block: {
            type: "form",
            data: {
              formId: "blk_form1",
              title: "Release notes",
              fields: [
                { id: "name", label: "Name", input: "text", required: true },
              ],
              submitLabel: "Save",
            },
          },
        },
      ],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

function fakeBackend() {
  let stored: Readonly<Record<string, string>> | null = null;
  const submitCalls: Readonly<Record<string, string>>[] = [];

  const actions: BlockResponseActions = {
    getResponses: async (): Promise<BlockResponseQuery> => ({
      kind: "ready",
      tally: {},
      total: 0,
      own: stored === null ? null : { kind: "form", values: stored },
    }),
    submitPoll: async () => ({ kind: "submitted" }),
    submitForm: async (_messageId, _blockId, values) => {
      submitCalls.push(values);
      stored = values;
      return { kind: "submitted" };
    },
    submitQuestion: async () => ({ kind: "submitted" }),
  };

  return {
    actions,
    submitCalls,
    get stored() {
      return stored;
    },
  };
}

// React tracks an input's last-known value internally to decide whether a
// native "input" event represents a real change; setting `.value` directly
// bypasses React's own setter and the event is dropped. Going through the
// native prototype's setter (then dispatching the event) is the standard
// workaround, the same one Testing Library's `fireEvent` performs
// internally.
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(actions: BlockResponseActions) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={messageWithFormBlock()}
        blockResponses={actions}
      />,
    );
  });
  return container;
}

describe("form card round-trip", () => {
  test("submitting a required field left blank shows an error and never calls the port", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    const form = el.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(backend.submitCalls).toHaveLength(0);
    expect(el.textContent).toContain("This field is required.");
  });

  test("a valid submit calls the port and locks into Submitted, read back from the port", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    const input = el.querySelector("input[type='text']") as HTMLInputElement;
    await act(async () => {
      setInputValue(input, "v2.0");
    });

    const form = el.querySelector("form") as HTMLFormElement;
    await act(async () => {
      form.requestSubmit();
    });

    expect(backend.submitCalls).toEqual([{ name: "v2.0" }]);
    expect(el.textContent).toContain("Submitted");
    expect(input.disabled).toBe(true);
  });

  test("Edit response re-enables the field and a resubmit overwrites the stored row", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    const firstInput = el.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(firstInput, "v2.0");
    });
    await act(async () => {
      (el.querySelector("form") as HTMLFormElement).requestSubmit();
    });

    const editButton = [
      ...el.querySelectorAll(".chat-block-actions button"),
    ].find(
      (button) => button.textContent === "Edit response",
    ) as HTMLButtonElement;
    await act(async () => {
      editButton.click();
    });

    const secondInput = el.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    expect(secondInput.disabled).toBe(false);
    await act(async () => {
      setInputValue(secondInput, "v2.1");
    });
    await act(async () => {
      (el.querySelector("form") as HTMLFormElement).requestSubmit();
    });

    expect(backend.submitCalls).toEqual([{ name: "v2.0" }, { name: "v2.1" }]);
    expect(backend.stored).toEqual({ name: "v2.1" });
    expect(el.textContent).toContain("Submitted");
  });

  test("with no port, the form renders disabled with the static pre-round-trip framing", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<WorkbenchTimeline items={messageWithFormBlock()} />);
    });

    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(container.querySelector("form")).toBeNull();
  });
});
