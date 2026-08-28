// WORKBENCH DELTA (see VENDORED.md): our two migrations ride behind
// upstream's in the drizzle-kit journal. Renumbering them at each re-pin
// is a hand edit, so pin the invariants drizzle-kit relies on: one journal
// entry per SQL file, in filename order, with non-decreasing `when`.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(import.meta.dir, "..", "migrations");

test("every migration file has a journal entry in filename order with non-decreasing `when`", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => file.slice(0, -".sql".length));
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: { idx: number; when: number; tag: string }[] };

  expect(journal.entries.map((entry) => entry.tag)).toEqual(files);
  journal.entries.forEach((entry, i) => {
    expect(entry.idx).toBe(i);
    expect(entry.tag.startsWith(String(i).padStart(4, "0"))).toBe(true);
    if (i > 0) expect(entry.when).toBeGreaterThanOrEqual(journal.entries[i - 1]!.when);
  });
});
