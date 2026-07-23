import { describe, expect, it } from "bun:test";
import { mapOrganizationListsToOptions } from "./index";

describe("mapOrganizationListsToOptions (CL-4279)", () => {
  it("maps a keyed array response to value/label options", () => {
    const options = mapOrganizationListsToOptions({
      organization_lists: [
        { id: 1, name: "Engine - Growth" },
        { id: 2, name: "Engine - Enterprise" },
      ],
    });
    expect(options).toEqual([
      { value: "1", label: "Engine - Growth" },
      { value: "2", label: "Engine - Enterprise" },
    ]);
  });

  it("maps a bare array response", () => {
    const options = mapOrganizationListsToOptions([
      { id: 7, name: "Pipeline" },
    ]);
    expect(options).toEqual([{ value: "7", label: "Pipeline" }]);
  });

  it("falls back to a generated label when name is missing", () => {
    const options = mapOrganizationListsToOptions([{ id: 9 }]);
    expect(options).toEqual([{ value: "9", label: "List 9" }]);
  });

  it("drops rows with no usable id", () => {
    const options = mapOrganizationListsToOptions([
      { name: "No id here" },
      { id: 3, name: "Has id" },
    ]);
    expect(options).toEqual([{ value: "3", label: "Has id" }]);
  });

  it("throws on a response shape it cannot recognize as a list", () => {
    expect(() => mapOrganizationListsToOptions({ unexpected: true })).toThrow(
      /unexpected response shape/,
    );
  });
});
