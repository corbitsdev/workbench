-- WORKBENCH DELTA (see VENDORED.md, CL-8162): the hub-side cron tick is gone —
-- a schedule-triggered workflow owns its cron through the native TimerSet
-- seam, so nothing claims a minute any more. Forward-only drop of the column
-- 0092 added.
ALTER TABLE "workflow_definition" DROP COLUMN IF EXISTS "schedule_claimed_minute";
