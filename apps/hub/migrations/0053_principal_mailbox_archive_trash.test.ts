import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("0053_principal_mailbox_archive_trash migration", () => {
  test("adds archive and trash markers with partial indexes", () => {
    const sql = readFileSync(
      join(import.meta.dir, "0053_principal_mailbox_archive_trash.sql"),
      "utf8",
    );
    expect(sql).toContain("archived_at");
    expect(sql).toContain("trashed_at");
    expect(sql).toContain("principal_mailbox_principal_active_created_idx");
    expect(sql).toContain('WHERE "trashed_at" IS NULL');
    expect(sql).toContain("unread counts exclude archived and trashed rows");
  });
});
