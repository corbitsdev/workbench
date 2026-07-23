-- CL-4212: schedules stored a bare UTC hour plus a once-a-day fire marker,
-- so the scheduler had no way to express sub-daily cadence (e.g. "every 5
-- minutes"). Replace with a genuinely evaluated recurrence:
--   interval_minutes  = how often the schedule fires
--   anchor_minute_utc = minute-of-UTC-day phase (0-1439) the cadence aligns to
-- The scheduler now tracks last_fired_window_index = floor((nowMinuteUtc -
-- anchor_minute_utc) / interval_minutes) and fires whenever that index is
-- GREATER THAN the one it last fired in (a catch-up rule — see
-- apps/hub/src/services/scheduler.ts shouldFire).
--
-- Existing rows are migrated, not dual-represented. Two cases:
--
--   1. A row that HAS fired before (last_fired_day_utc IS NOT NULL): the old
--      daily-at-hour model is exactly interval_minutes=1440,
--      anchor_minute_utc=hour_utc*60, and for that case last_fired_window_index
--      is numerically identical to the old last_fired_day_utc (a fire at day
--      D, hour H always lands in window D — see scheduler.test.ts), so the
--      backfill is a lossless rename. It keeps firing at the same wall-clock
--      time after this deploys.
--
--   2. A row that has NEVER fired (last_fired_day_utc IS NULL): naively
--      copying NULL through would leave last_fired_window_index NULL, and
--      the scheduler's catch-up rule treats "no last-fired window" as
--      "overdue since the beginning of time" — it would fire on the very
--      first tick after this migration runs, at whatever time the deploy
--      happens, not at the schedule's configured hour. This is the same
--      problem application code solves at write time by stamping
--      last_fired_window_index to the CURRENT window on
--      create/ensure/retarget (scheduled-triggers.ts) — the migration gives
--      never-fired rows that same stamp, computed from the migration's own
--      clock (NOW()) so it is deterministic at apply time. The schedule then
--      fires at its next real boundary, exactly as if it had just been
--      created.

ALTER TABLE "scheduled_trigger"
  ADD COLUMN "interval_minutes" integer,
  ADD COLUMN "anchor_minute_utc" integer,
  ADD COLUMN "last_fired_window_index" integer;

UPDATE "scheduled_trigger"
SET
  "interval_minutes" = 1440,
  "anchor_minute_utc" = "hour_utc" * 60;

-- Case 1: has fired before — numerically identical rename, no clock read.
UPDATE "scheduled_trigger"
SET "last_fired_window_index" = "last_fired_day_utc"
WHERE "last_fired_day_utc" IS NOT NULL;

-- Case 2: never fired — stamp to the window index current AT MIGRATION TIME
-- (the same value application code stamps at creation), so it fires at its
-- next boundary rather than immediately on the next scheduler tick.
UPDATE "scheduled_trigger"
SET "last_fired_window_index" = FLOOR(
  (FLOOR(EXTRACT(EPOCH FROM NOW()) / 60) - "anchor_minute_utc") / "interval_minutes"
)
WHERE "last_fired_day_utc" IS NULL;

ALTER TABLE "scheduled_trigger"
  ALTER COLUMN "interval_minutes" SET NOT NULL,
  ALTER COLUMN "anchor_minute_utc" SET NOT NULL,
  ALTER COLUMN "last_fired_window_index" SET NOT NULL;

ALTER TABLE "scheduled_trigger"
  ADD CONSTRAINT "scheduled_trigger_interval_check" CHECK ("interval_minutes" >= 1),
  ADD CONSTRAINT "scheduled_trigger_anchor_check" CHECK ("anchor_minute_utc" >= 0 AND "anchor_minute_utc" < 1440);

ALTER TABLE "scheduled_trigger"
  DROP COLUMN "hour_utc",
  DROP COLUMN "last_fired_day_utc";
