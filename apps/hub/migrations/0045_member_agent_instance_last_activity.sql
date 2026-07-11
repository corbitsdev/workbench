-- Add nullable first so the backfill can distinguish rows it has seeded from
-- rows it has not; the NOT NULL + default are applied at the end.
ALTER TABLE "member_agent_instance" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp;

-- Seed every row from created_at so a thread that was never messaged orders by
-- its creation time, not the migration time. (A blanket DEFAULT now() would sort
-- every never-used thread to the very top.)
UPDATE "member_agent_instance"
SET "last_activity_at" = "created_at"
WHERE "last_activity_at" IS NULL;

-- Then override with the most recent inference turn where one exists, so day-one
-- ordering reflects real activity. Guarded on the interchange table's presence:
-- workbench migrations run against the shared DB but must not assume
-- inference_turn exists yet.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables WHERE table_name = 'inference_turn'
  ) THEN
    UPDATE "member_agent_instance" m
    SET "last_activity_at" = t.max_started
    FROM (
      SELECT instance_id, MAX(started_at) AS max_started
      FROM "inference_turn"
      GROUP BY instance_id
    ) t
    WHERE t.instance_id = m.instance_id
      -- Only override rows still at their seed value, so re-running this
      -- migration cannot clobber a last_activity_at since bumped by real traffic.
      AND m."last_activity_at" = m."created_at";
  END IF;
END $$;

-- Future inserts default to now(); every existing row is seeded above.
ALTER TABLE "member_agent_instance" ALTER COLUMN "last_activity_at" SET DEFAULT now();
ALTER TABLE "member_agent_instance" ALTER COLUMN "last_activity_at" SET NOT NULL;
