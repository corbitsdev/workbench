-- Optional display label for a member's agent instance row (e.g. Myra chat threads).

ALTER TABLE "member_agent_instance"
  ADD COLUMN IF NOT EXISTS "label" text;