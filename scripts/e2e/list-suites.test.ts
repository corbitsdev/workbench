import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSuites } from "./list-suites.ts";

test("listSuites includes a fixture suite and folds the unit files together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-list-suites-"));
  try {
    for (const name of [
      "chat.test.ts",
      "harness.test.ts",
      "db-gate.test.ts",
      "db-setup.test.ts",
      "not-a-suite.ts",
    ]) {
      await writeFile(join(dir, name), "");
    }

    const suites = await listSuites(dir);

    expect(suites).toContain("chat");
    expect(suites).toContain("unit");
    expect(suites).not.toContain("harness");
    expect(suites).not.toContain("db-gate");
    expect(suites).not.toContain("db-setup");
    expect(suites).not.toContain("list-suites");
    expect(suites).not.toContain("not-a-suite");
    expect(suites.filter((suite) => suite === "unit")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
