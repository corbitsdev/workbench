import { describe, expect, test } from "bun:test";

import { detailPath } from "./detail-paths";

describe("detailPath", () => {
  test("an entity's own slug addresses its detail route", () => {
    expect(detailPath("/agents", { slug: "weekly-digest", id: "wfd_1" })).toBe(
      "/agents/weekly-digest",
    );
  });

  test("a slug is never derived from a display name", () => {
    expect(detailPath("/agents", { slug: "Café Crème Bot", id: "wfd_2" })).toBe(
      "/agents/wfd_2",
    );
    expect(detailPath("/skills", { slug: "", id: "skill_1" })).toBe(
      "/skills/skill_1",
    );
  });

  test("the id fallback survives a segment that needs escaping", () => {
    expect(detailPath("/plugins", { slug: "Not A Slug", id: "a/b" })).toBe(
      "/plugins/a%2Fb",
    );
  });
});
