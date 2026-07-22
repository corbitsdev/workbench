-- CL-4153: cut Granola note processing over onto work_unit (kind granola_call).
-- Copies open specialized rows so in-flight / pending notes are not lost, then
-- marks those specialized rows done so the legacy table is no longer the runtime
-- path. Table drop is a follow-up once staging has drained.

INSERT INTO work_unit (
  tenant_id,
  kind,
  idempotency_key,
  status,
  payload,
  attempts,
  max_attempts,
  next_attempt_at,
  lease_owner,
  lease_until,
  last_error,
  created_at,
  updated_at
)
SELECT
  g.tenant_id,
  'granola_call',
  'note:' || g.note_id,
  CASE g.status
    WHEN 'processing' THEN 'leased'
    WHEN 'pending' THEN 'pending'
    WHEN 'dead' THEN 'dead'
    ELSE 'done'
  END,
  jsonb_build_object('noteId', g.note_id),
  g.attempts,
  8,
  g.next_attempt_at,
  g.lease_owner,
  g.lease_until,
  g.last_error,
  g.created_at,
  g.updated_at
FROM granola_call_job AS g
WHERE g.status IN ('pending', 'processing', 'dead')
ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING;

-- Legacy path is retired at runtime; close specialized rows that were migrated
-- so ops do not double-count depth across two tables.
UPDATE granola_call_job
SET
  status = 'done',
  last_error = COALESCE(last_error, 'migrated to work_unit (CL-4153)'),
  lease_owner = NULL,
  lease_until = NULL,
  updated_at = now()
WHERE status IN ('pending', 'processing', 'dead');
