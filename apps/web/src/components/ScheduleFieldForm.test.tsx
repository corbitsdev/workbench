/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { ScheduleFieldMetadata } from "@workbench/shared";
import { ScheduleFieldForm, scheduleFieldsComplete } from "./ScheduleFieldForm";

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

afterEach(() => {
  cleanup();
});

describe("ScheduleFieldForm (CL-3861)", () => {
  it("renders labels, help, and profile chip from metadata", () => {
    render(
      <ScheduleFieldForm fields={fields} values={{}} onChange={() => {}} />,
    );
    expect(screen.getByLabelText(/Topic/)).toBeTruthy();
    expect(screen.getByText("What to research")).toBeTruthy();
    expect(screen.getByTestId("from-profile-chip-email")).toBeTruthy();
  });

  it("renders empty state when no fields", () => {
    render(<ScheduleFieldForm fields={[]} values={{}} onChange={() => {}} />);
    expect(screen.getByTestId("schedule-field-form-empty")).toBeTruthy();
  });

  it("scheduleFieldsComplete enforces required non-profile fields", () => {
    expect(scheduleFieldsComplete(fields, {})).toBe(false);
    expect(scheduleFieldsComplete(fields, { topic: "x" })).toBe(true);
    expect(scheduleFieldsComplete(fields, { topic: "  " })).toBe(false);
  });
});
