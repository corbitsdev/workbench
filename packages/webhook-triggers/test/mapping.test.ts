import { describe, expect, test } from "bun:test";
import { renderInputTemplate } from "../src/mapping";

describe("renderInputTemplate", () => {
  test("substitutes a top-level field", () => {
    expect(renderInputTemplate("hello {{name}}", { name: "granola" })).toBe(
      "hello granola",
    );
  });

  test("substitutes a nested dotted path", () => {
    const payload = { meeting: { title: "Standup", attendees: 3 } };
    expect(renderInputTemplate("New meeting: {{meeting.title}}", payload)).toBe(
      "New meeting: Standup",
    );
  });

  test("stringifies non-string leaf values", () => {
    expect(
      renderInputTemplate("count={{meeting.attendees}}", {
        meeting: { attendees: 3 },
      }),
    ).toBe("count=3");
  });

  test("resolves a missing path to an empty string rather than throwing", () => {
    expect(renderInputTemplate("value={{missing.path}}", {})).toBe("value=");
  });

  test("resolves a path through a non-object value to empty string", () => {
    expect(renderInputTemplate("v={{a.b}}", { a: "not-an-object" })).toBe("v=");
  });

  test("renders an object leaf as JSON", () => {
    expect(renderInputTemplate("data={{payload}}", { payload: { a: 1 } })).toBe(
      'data={"a":1}',
    );
  });

  test("leaves a template with no placeholders untouched", () => {
    expect(renderInputTemplate("no placeholders here", { a: 1 })).toBe(
      "no placeholders here",
    );
  });
});
