import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import {
  ScheduleFieldMetadataSchema,
  buildScheduleTriggerPayload,
  fallbackScheduleFields,
  scheduleFieldInputHint,
  scheduleFieldsMatchIntakeSchema,
  sortScheduleFields,
  type ScheduleFieldMetadata,
} from "./index";

describe("ScheduleFieldMetadataSchema (CL-3860)", () => {
  it("accepts legacy kind-only intake fields", () => {
    const parsed = ScheduleFieldMetadataSchema({
      name: "topic",
      label: "Topic",
      kind: "text",
      required: true,
    });
    expect(parsed instanceof type.errors).toBe(false);
    if (parsed instanceof type.errors) return;
    expect(scheduleFieldInputHint(parsed)).toBe("text");
  });

  it("prefers inputHint over kind", () => {
    const field = {
      name: "url",
      label: "URL",
      kind: "text" as const,
      inputHint: "url" as const,
    };
    expect(scheduleFieldInputHint(field)).toBe("url");
  });

  it("accepts help, order, options, fromProfile", () => {
    const parsed = ScheduleFieldMetadataSchema({
      name: "region",
      label: "Region",
      inputHint: "select",
      help: "Pick a region",
      order: 2,
      options: [{ value: "us", label: "US" }],
      fromProfile: "homeRegion",
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("accepts defaultValue and numeric bounds (CL-4538)", () => {
    const parsed = ScheduleFieldMetadataSchema({
      name: "days",
      label: "Research window (days)",
      inputHint: "number",
      defaultValue: 30,
      min: 1,
      step: 1,
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("accepts a select field backed by a live optionsSource (CL-4279)", () => {
    const parsed = ScheduleFieldMetadataSchema({
      name: "growthEngineListId",
      label: "Engine - Growth Sumble list",
      inputHint: "select",
      optionsSource: "sumble-organization-lists",
      required: true,
    });
    expect(parsed instanceof type.errors).toBe(false);
  });
});

describe("sortScheduleFields", () => {
  it("orders by order then name", () => {
    const fields: ScheduleFieldMetadata[] = [
      { name: "b", label: "B", order: 1 },
      { name: "a", label: "A", order: 0 },
      { name: "z", label: "Z" },
      { name: "m", label: "M" },
    ];
    expect(sortScheduleFields(fields).map((f) => f.name)).toEqual([
      "a",
      "b",
      "m",
      "z",
    ]);
  });
});

describe("fallbackScheduleFields", () => {
  it("labels fields with their name as text inputs", () => {
    expect(fallbackScheduleFields(["foo", "bar"])).toEqual([
      { name: "foo", label: "foo", inputHint: "text", order: 0 },
      { name: "bar", label: "bar", inputHint: "text", order: 1 },
    ]);
  });
});

describe("scheduleFieldsMatchIntakeSchema", () => {
  it("returns true when every metadata name is in the schema set", () => {
    expect(
      scheduleFieldsMatchIntakeSchema(
        [{ name: "topic", label: "Topic" }],
        new Set(["topic", "focus"]),
      ),
    ).toBe(true);
  });

  it("returns false on drift", () => {
    expect(
      scheduleFieldsMatchIntakeSchema(
        [{ name: "unknown", label: "X" }],
        new Set(["topic"]),
      ),
    ).toBe(false);
  });
});

describe("buildScheduleTriggerPayload", () => {
  const fields: ScheduleFieldMetadata[] = [
    { name: "topic", label: "Topic" },
    { name: "region", label: "Region", fromProfile: "homeRegion" },
    { name: "notes", label: "Notes" },
  ];

  it("keeps fields with real values", () => {
    expect(
      buildScheduleTriggerPayload(fields, {
        topic: "GTM",
        region: "us-east",
        notes: "hello",
      }),
    ).toEqual({ topic: "GTM", notes: "hello" });
  });

  it("drops fromProfile fields regardless of draft value", () => {
    const payload = buildScheduleTriggerPayload(fields, {
      topic: "GTM",
      region: "us-east",
    });
    expect(payload).not.toHaveProperty("region");
  });

  it("drops undefined, null, and blank-string values", () => {
    expect(
      buildScheduleTriggerPayload(fields, {
        topic: undefined,
        notes: "   ",
      }),
    ).toEqual({});
  });

  it("returns an empty object when there are no fields", () => {
    expect(buildScheduleTriggerPayload([], { topic: "GTM" })).toEqual({});
  });

  it("submits a field's defaultValue when the member never touched it (CL-4538)", () => {
    const withDefault: ScheduleFieldMetadata[] = [
      { name: "topic", label: "Topic" },
      { name: "days", label: "Days", inputHint: "number", defaultValue: 30 },
    ];
    expect(buildScheduleTriggerPayload(withDefault, { topic: "GTM" })).toEqual(
      { topic: "GTM", days: 30 },
    );
  });
});
