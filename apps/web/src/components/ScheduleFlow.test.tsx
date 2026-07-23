/// <reference types="bun" />
import "../test-setup";
import { useState } from "react";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  ScheduleFieldMetadata,
  ScheduleRecurrence,
  WorkflowCatalogEntry,
} from "@workbench/shared";
import { ScheduleFlow } from "./ScheduleFlow";

const baseEntry: WorkflowCatalogEntry = {
  kind: "gamma",
  label: "Gamma",
  description: "Make decks",
  isFavorite: false,
  stepCount: 1,
  pauseCount: 0,
  steps: [],
  attachable: true,
  allowedScopes: ["personal", "tenant"],
  defaultScope: "personal",
  intakeFields: [],
};

const topicFields: ScheduleFieldMetadata[] = [
  {
    name: "topic",
    label: "Topic",
    inputHint: "text",
    required: true,
    order: 0,
  },
];

const daily: ScheduleRecurrence = {
  intervalMinutes: 1440,
  anchorMinuteUtc: 14 * 60,
};

afterEach(() => {
  cleanup();
});

describe("ScheduleFlow", () => {
  it("renders every applicable section at once, with no step nav", () => {
    const onSave = mock(() => undefined);
    render(
      <ScheduleFlow
        entry={baseEntry}
        productLabel="Gamma"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    expect(screen.queryByTestId("schedule-flow-steps")).toBeNull();
    expect(screen.getByText("Gamma")).toBeTruthy();
    expect(screen.getByLabelText("How often")).toBeTruthy();
    expect(screen.getByLabelText("Starting at")).toBeTruthy();
    expect(screen.getByText(/Who is this for/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(onSave).toHaveBeenCalled();
  });

  it("includes inputs when fields exist and blocks save until required filled", () => {
    const onSave = mock(() => undefined);
    let values: Record<string, unknown> = {};
    const { rerender } = render(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "last30days-research",
          allowedScopes: ["personal"],
          intakeFields: topicFields,
        }}
        productLabel="Research"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={values}
        onFieldValuesChange={(next) => {
          values = next;
        }}
        fields={topicFields}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );

    expect(screen.getByText(/Inputs for each run/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(screen.getByText("Fill in the required fields.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/Topic/), {
      target: { value: "AI agents" },
    });
    values = { topic: "AI agents" };
    rerender(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "last30days-research",
          allowedScopes: ["personal"],
          intakeFields: topicFields,
        }}
        productLabel="Research"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={values}
        onFieldValuesChange={(next) => {
          values = next;
        }}
        fields={topicFields}
        error={null}
        onCancel={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByTestId("schedule-flow-primary"));
    expect(onSave).toHaveBeenCalled();
  });

  it("round-trips a sub-hourly interval selection through save and back into the editor (CL-4278)", () => {
    const onSave = mock(() => undefined);

    function Harness({ persisted }: { persisted: ScheduleRecurrence }) {
      const [recurrence, setRecurrence] = useState(persisted);
      return (
        <ScheduleFlow
          entry={baseEntry}
          productLabel="Gamma"
          recurrence={recurrence}
          onRecurrenceChange={setRecurrence}
          scope="personal"
          onScopeChange={() => undefined}
          fieldValues={{}}
          onFieldValuesChange={() => undefined}
          fields={[]}
          error={null}
          onCancel={() => undefined}
          onSave={onSave}
        />
      );
    }

    const { rerender } = render(<Harness key="a" persisted={daily} />);

    const unitSelect = screen.getByLabelText("Interval unit");
    fireEvent.change(unitSelect, { target: { value: "minutes" } });
    const amountInput = screen.getByLabelText("How often") as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "5" } });

    expect(amountInput.value).toBe("5");
    expect((unitSelect as HTMLSelectElement).value).toBe("minutes");

    const saved: ScheduleRecurrence = {
      intervalMinutes: 5,
      anchorMinuteUtc: 14 * 60,
    };

    // Reopen: a fresh mount with the saved recurrence must select the same
    // amount/unit back into the controls.
    rerender(<Harness key="b" persisted={saved} />);
    expect((screen.getByLabelText("How often") as HTMLInputElement).value).toBe(
      "5",
    );
    expect(
      (screen.getByLabelText("Interval unit") as HTMLSelectElement).value,
    ).toBe("minutes");
    expect(screen.getByText(/Every 5 minutes, starting at/)).toBeTruthy();
  });

  it("locks the interval control to Once a day for a daily-only kind (heartbeat)", () => {
    render(
      <ScheduleFlow
        entry={{
          ...baseEntry,
          kind: "heartbeat",
          allowedScopes: ["personal"],
        }}
        productLabel="Morning brief"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId("recurrence-daily-only-heartbeat")).toBeTruthy();
    expect(screen.queryByLabelText("Interval unit")).toBeNull();
  });

  it("collapses availability on edit and shows the scope-lock note", () => {
    render(
      <ScheduleFlow
        entry={baseEntry}
        productLabel="Gamma"
        existing={{ scope: "tenant" }}
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="tenant"
        onScopeChange={() => undefined}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.queryByText(/Who is this for/)).toBeNull();
    expect(screen.getByText(/Editing schedule/)).toBeTruthy();
    expect(
      screen.getByText(/Scope is set when a schedule is created/),
    ).toBeTruthy();
  });

  it("lets the user choose scope directly, no navigation required", () => {
    const onScopeChange = mock(() => undefined);
    render(
      <ScheduleFlow
        entry={baseEntry}
        productLabel="Gamma"
        recurrence={daily}
        onRecurrenceChange={() => undefined}
        scope="personal"
        onScopeChange={onScopeChange}
        fieldValues={{}}
        onFieldValuesChange={() => undefined}
        fields={[]}
        error={null}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /everyone/i }));
    expect(onScopeChange).toHaveBeenCalledWith("tenant");
  });
});
