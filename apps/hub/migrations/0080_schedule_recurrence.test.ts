import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scheduledTrigger } from "../src/db/schema";
import { shouldFire, windowIndexFor } from "../src/services/scheduler";

const sql = readFileSync(
  join(import.meta.dir, "0080_schedule_recurrence.sql"),
  "utf8",
);

describe("migration 0080_schedule_recurrence", () => {
  it("adds the recurrence columns", () => {
    expect(sql).toMatch(/ADD COLUMN "interval_minutes" integer/);
    expect(sql).toMatch(/ADD COLUMN "anchor_minute_utc" integer/);
    expect(sql).toMatch(/ADD COLUMN "last_fired_window_index" integer/);
  });

  it("backfills interval_minutes=1440 and anchor_minute_utc=hour_utc*60", () => {
    expect(sql).toMatch(/"interval_minutes" = 1440/);
    expect(sql).toMatch(/"anchor_minute_utc" = "hour_utc" \* 60/);
  });

  it("backfills last_fired_window_index=last_fired_day_utc only for rows that have fired", () => {
    expect(sql).toMatch(
      /SET "last_fired_window_index" = "last_fired_day_utc"\s*\nWHERE "last_fired_day_utc" IS NOT NULL/,
    );
  });

  it("backfills a computed current-window index for never-fired rows, not NULL", () => {
    // Must NOT let a never-fired row's last_fired_window_index simply stay
    // NULL — under shouldFire's catch-up rule, NULL/absent reads as "overdue
    // since the beginning of time" and would fire on the very next tick after
    // this migration deploys, at whatever time that happens to be, instead of
    // the schedule's configured time.
    expect(sql).toMatch(/WHERE "last_fired_day_utc" IS NULL/);
    expect(sql).toMatch(
      /SET "last_fired_window_index" = FLOOR\(\s*\(FLOOR\(EXTRACT\(EPOCH FROM NOW\(\)\) \/ 60\) - "anchor_minute_utc"\) \/ "interval_minutes"\s*\)/,
    );
  });

  it("last_fired_window_index is NOT NULL after backfill — no residual ambiguity", () => {
    expect(sql).toMatch(/ALTER COLUMN "last_fired_window_index" SET NOT NULL/);
  });

  it("adds bounds check constraints", () => {
    expect(sql).toMatch(/CHECK \("interval_minutes" >= 1\)/);
    expect(sql).toMatch(
      /CHECK \("anchor_minute_utc" >= 0 AND "anchor_minute_utc" < 1440\)/,
    );
  });

  it("drops the retired hour_utc and last_fired_day_utc columns", () => {
    expect(sql).toMatch(/DROP COLUMN "hour_utc"/);
    expect(sql).toMatch(/DROP COLUMN "last_fired_day_utc"/);
  });

  it("both backfill UPDATEs run before the retired columns are dropped", () => {
    const firedBackfillIdx = sql.indexOf(
      'SET "last_fired_window_index" = "last_fired_day_utc"',
    );
    const neverFiredBackfillIdx = sql.indexOf(
      'WHERE "last_fired_day_utc" IS NULL',
    );
    const dropIdx = sql.indexOf('DROP COLUMN "last_fired_day_utc"');
    expect(firedBackfillIdx).toBeGreaterThan(-1);
    expect(neverFiredBackfillIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeGreaterThan(firedBackfillIdx);
    expect(dropIdx).toBeGreaterThan(neverFiredBackfillIdx);
  });

  it("hour_utc and last_fired_day_utc are no longer Drizzle columns", () => {
    expect(Object.keys(scheduledTrigger)).not.toContain("hourUtc");
    expect(Object.keys(scheduledTrigger)).not.toContain("lastFiredDayUtc");
  });

  it("interval_minutes, anchor_minute_utc, last_fired_window_index are Drizzle columns", () => {
    expect(Object.keys(scheduledTrigger)).toContain("intervalMinutes");
    expect(Object.keys(scheduledTrigger)).toContain("anchorMinuteUtc");
    expect(Object.keys(scheduledTrigger)).toContain("lastFiredWindowIndex");
  });
});

// The assertion that actually matters: replicate the SQL backfill formula in
// JS (same arithmetic, `FLOOR((FLOOR(EXTRACT(EPOCH FROM NOW())/60) -
// anchor_minute_utc) / interval_minutes)`) for a never-fired row, then feed
// the result through the REAL production `shouldFire`/`windowIndexFor` from
// scheduler.ts — not a hand-rolled reimplementation — to prove the backfilled
// value behaves correctly against the scheduler these rows are actually
// evaluated by.
describe("0080 backfill formula for never-fired rows, exercised against the real scheduler", () => {
  function backfillNeverFiredWindowIndex(
    migrationApplyMs: number,
    intervalMinutes: number,
    anchorMinuteUtc: number,
  ): number {
    const nowMinuteUtc = Math.floor(migrationApplyMs / 60_000);
    return Math.floor((nowMinuteUtc - anchorMinuteUtc) / intervalMinutes);
  }

  it("a never-fired daily row does not fire on the first tick right after migration", () => {
    const hourUtc = 9;
    const anchorMinuteUtc = hourUtc * 60;
    const intervalMinutes = 1440;
    // Migration runs mid-afternoon, well past today's 9am anchor.
    const migrationApplyMs = Date.UTC(2026, 0, 15, 14, 30, 0);
    const backfilled = backfillNeverFiredWindowIndex(
      migrationApplyMs,
      intervalMinutes,
      anchorMinuteUtc,
    );

    // The very next scheduler tick, seconds after the migration applies.
    const firstTickAfterDeploy = migrationApplyMs + 5_000;
    expect(
      shouldFire(
        firstTickAfterDeploy,
        backfilled,
        intervalMinutes,
        anchorMinuteUtc,
      ),
    ).toBe(false);
  });

  it("that same never-fired row DOES fire at its next real 9am boundary", () => {
    const hourUtc = 9;
    const anchorMinuteUtc = hourUtc * 60;
    const intervalMinutes = 1440;
    const migrationApplyMs = Date.UTC(2026, 0, 15, 14, 30, 0);
    const backfilled = backfillNeverFiredWindowIndex(
      migrationApplyMs,
      intervalMinutes,
      anchorMinuteUtc,
    );

    const nextNineAm = Date.UTC(2026, 0, 16, 9, 0, 0);
    expect(
      shouldFire(nextNineAm, backfilled, intervalMinutes, anchorMinuteUtc),
    ).toBe(true);
    expect(windowIndexFor(nextNineAm, intervalMinutes, anchorMinuteUtc)).toBe(
      backfilled + 1,
    );
  });

  it("a never-fired sub-daily row (e.g. granola-call every 5 minutes) does not fire immediately either", () => {
    const intervalMinutes = 5;
    const anchorMinuteUtc = 0;
    const migrationApplyMs = Date.UTC(2026, 0, 15, 14, 32, 17);
    const backfilled = backfillNeverFiredWindowIndex(
      migrationApplyMs,
      intervalMinutes,
      anchorMinuteUtc,
    );

    expect(
      shouldFire(
        migrationApplyMs + 3_000,
        backfilled,
        intervalMinutes,
        anchorMinuteUtc,
      ),
    ).toBe(false);

    // Fires at the next 5-minute boundary after the migration's clock read.
    const nextFiveMinuteBoundary = Date.UTC(2026, 0, 15, 14, 35, 0);
    expect(
      shouldFire(
        nextFiveMinuteBoundary,
        backfilled,
        intervalMinutes,
        anchorMinuteUtc,
      ),
    ).toBe(true);
  });
});
