/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ScheduleFieldMetadata } from "@workbench/shared";

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    workbenches: [],
    loading: false,
    activeWorkbench: null,
    activeTenantId: "tnt_1",
    setActiveWorkbench: () => {},
  }),
}));

const { ScheduleFieldForm, scheduleFieldsComplete } = await import(
  "./ScheduleFieldForm"
);

const fields: ScheduleFieldMetadata[] = [
  {
    name: "topic",
    label: "Topic",
    inputHint: "text",
    required: true,
    order: 0,
    help: "What to research",
  },
  {
    name: "focus",
    label: "Focus",
    inputHint: "textarea",
    order: 1,
  },
  {
    name: "email",
    label: "Email",
    inputHint: "text",
    fromProfile: "workEmail",
    order: 2,
  },
];

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(React.createElement(QueryClientProvider, { client }, ui));
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("ScheduleFieldForm (CL-3861)", () => {
  it("renders labels, help, and profile chip from metadata", () => {
    renderWithQuery(
      <ScheduleFieldForm fields={fields} values={{}} onChange={() => {}} />,
    );
    expect(screen.getByLabelText(/Topic/)).toBeTruthy();
    expect(screen.getByText("What to research")).toBeTruthy();
    expect(screen.getByTestId("from-profile-chip-email")).toBeTruthy();
  });

  it("renders empty state when no fields", () => {
    renderWithQuery(
      <ScheduleFieldForm fields={[]} values={{}} onChange={() => {}} />,
    );
    expect(screen.getByTestId("schedule-field-form-empty")).toBeTruthy();
  });

  it("scheduleFieldsComplete enforces required non-profile fields", () => {
    expect(scheduleFieldsComplete(fields, {})).toBe(false);
    expect(scheduleFieldsComplete(fields, { topic: "x" })).toBe(true);
    expect(scheduleFieldsComplete(fields, { topic: "  " })).toBe(false);
  });

  it("a free-text field is unaffected by option-source rendering", () => {
    renderWithQuery(
      <ScheduleFieldForm fields={fields} values={{}} onChange={() => {}} />,
    );
    const topic = screen.getByLabelText(/Topic/) as HTMLInputElement;
    expect(topic.tagName).toBe("INPUT");
    expect(topic.type).toBe("text");
  });
});

describe("ScheduleFieldForm number bounds and defaults (CL-4538)", () => {
  const daysField: ScheduleFieldMetadata = {
    name: "days",
    label: "Research window (days)",
    inputHint: "number",
    required: true,
    defaultValue: 30,
    min: 1,
    step: 1,
    order: 0,
  };

  it("renders the declared defaultValue as a real initial value, not a placeholder", () => {
    renderWithQuery(
      <ScheduleFieldForm fields={[daysField]} values={{}} onChange={() => {}} />,
    );
    const input = screen.getByLabelText(/Research window/) as HTMLInputElement;
    expect(input.value).toBe("30");
  });

  it("submits the default when the member never touches the field", () => {
    expect(scheduleFieldsComplete([daysField], {})).toBe(true);
  });

  it("renders the declared min and step on the numeric input", () => {
    renderWithQuery(
      <ScheduleFieldForm fields={[daysField]} values={{}} onChange={() => {}} />,
    );
    const input = screen.getByLabelText(/Research window/) as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.step).toBe("1");
  });
});

describe("ScheduleFieldForm option-backed field (CL-4279)", () => {
  const optionField: ScheduleFieldMetadata = {
    name: "growthEngineListId",
    label: "Engine - Growth Sumble list",
    inputHint: "select",
    optionsSource: "sumble-organization-lists",
    required: true,
  };

  it("renders as a select populated from the source, and submits the id not the label", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        jsonResponse({
          options: [
            { value: "101", label: "Engine - Growth" },
            { value: "202", label: "Engine - Enterprise" },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    let latestValues: Record<string, unknown> = {};
    const onChange = (next: Record<string, unknown>) => {
      latestValues = next;
    };

    renderWithQuery(
      <ScheduleFieldForm
        fields={[optionField]}
        values={{}}
        onChange={onChange}
      />,
    );

    const select = await screen.findByLabelText(/Engine - Growth Sumble list/);
    await waitFor(() => {
      expect(screen.getByText("Engine - Growth")).toBeTruthy();
    });

    await userEvent.selectOptions(select, "101");
    expect(latestValues.growthEngineListId).toBe("101");
  });

  it("surfaces a failure state rather than an empty select", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ error: "Sumble unreachable" }, 502)),
    ) as unknown as typeof fetch;

    renderWithQuery(
      <ScheduleFieldForm
        fields={[optionField]}
        values={{}}
        onChange={() => {}}
      />,
    );

    const error = await screen.findByTestId(
      "field-options-error-growthEngineListId",
    );
    expect(error.textContent).toMatch(/Could not load options/);
    expect(screen.queryByLabelText(/Engine - Growth Sumble list/)).toBeNull();
  });
});

describe("ScheduleFieldForm select-multi people picker", () => {
  const multiField: ScheduleFieldMetadata = {
    name: "authors",
    label: "Authors",
    inputHint: "select-multi",
    required: false,
  };

  function mockMembers() {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        jsonResponse({
          members: [
            { id: "prn_a", name: "Alex", refId: "u_alex" },
            { id: "prn_b", name: "Pontus", refId: "u_pontus" },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
  }

  function renderPicker(initial: Record<string, unknown>) {
    function Harness() {
      const [values, setValues] = React.useState(initial);
      return (
        <>
          <ScheduleFieldForm
            fields={[multiField]}
            values={values}
            onChange={setValues}
          />
          <pre data-testid="values-json">{JSON.stringify(values)}</pre>
        </>
      );
    }
    renderWithQuery(<Harness />);
  }

  it("stores each pick as a refId/displayName pair", async () => {
    mockMembers();
    renderPicker({});

    await waitFor(() => {
      expect(screen.getByLabelText("Alex")).toBeTruthy();
    });

    await userEvent.click(screen.getByLabelText("Alex"));
    await waitFor(() => {
      expect(screen.getByTestId("values-json").textContent).toBe(
        JSON.stringify({
          authors: [{ refId: "u_alex", displayName: "Alex" }],
        }),
      );
    });

    await userEvent.click(screen.getByLabelText("Pontus"));
    await waitFor(() => {
      expect(screen.getByTestId("values-json").textContent).toBe(
        JSON.stringify({
          authors: [
            { refId: "u_alex", displayName: "Alex" },
            { refId: "u_pontus", displayName: "Pontus" },
          ],
        }),
      );
    });
  });

  it("yields an empty selection, not everyone, when the last pick is cleared", async () => {
    mockMembers();
    renderPicker({ authors: [{ refId: "u_alex", displayName: "Alex" }] });

    await waitFor(() => {
      expect((screen.getByLabelText("Alex") as HTMLInputElement).checked).toBe(
        true,
      );
    });

    await userEvent.click(screen.getByLabelText("Alex"));
    await waitFor(() => {
      expect(screen.getByTestId("values-json").textContent).toBe(
        JSON.stringify({ authors: [] }),
      );
    });
    expect((screen.getByLabelText("Pontus") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("captions the checkbox group without pointing a label at it", async () => {
    mockMembers();
    renderPicker({});

    const group = await screen.findByTestId("field-select-multi-authors");
    expect(group.getAttribute("id")).toBeNull();
    const labelledBy = group.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("sched-field-authors-label");
    expect(document.getElementById(labelledBy as string)?.tagName).toBe("SPAN");
  });
});
