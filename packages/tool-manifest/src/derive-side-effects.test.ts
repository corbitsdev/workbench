import { describe, expect, test } from "bun:test";
import {
  loadCommittedToolManifestFactories,
  writeBareToolNamesFromFactories,
} from "./index";

describe("writeBareToolNamesFromFactories", () => {
  test("includes linear writes from the committed index", () => {
    const writes = writeBareToolNamesFromFactories(
      loadCommittedToolManifestFactories(),
    );
    expect(writes).toContain("linear_create_issue");
    expect(writes).toContain("linear_update_issue");
    expect(writes).not.toContain("linear_list_issues");
  });
});
