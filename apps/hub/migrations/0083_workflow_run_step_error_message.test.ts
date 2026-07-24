import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowRunStep } from "../src/db/schema";

const sql = readFileSync(
  join(import.meta.dir, "0083_workflow_run_step_error_message.sql"),
  "utf8",
);

describe("migration 0083_workflow_run_step_error_message", () => {
  it("adds the nullable error_message column to workflow_run_step", () => {
    expect(sql).toMatch(/ALTER TABLE "workflow_run_step"/);
    expect(sql).toMatch(/ADD COLUMN "error_message" text/);
  });

  it("does not force a NOT NULL constraint on error_message (existing rows have no error)", () => {
    expect(sql).not.toMatch(/error_message"\s+text\s+NOT NULL/i);
  });

  it("adds retries_exhausted NOT NULL DEFAULT false -- a pre-migration failed row must never satisfy the dead-parked-run join by default", () => {
    expect(sql).toMatch(
      /ADD COLUMN "retries_exhausted" boolean NOT NULL DEFAULT false/,
    );
  });

  it("errorMessage and retriesExhausted are Drizzle columns on workflowRunStep", () => {
    expect(Object.keys(workflowRunStep)).toContain("errorMessage");
    expect(Object.keys(workflowRunStep)).toContain("retriesExhausted");
  });
});
