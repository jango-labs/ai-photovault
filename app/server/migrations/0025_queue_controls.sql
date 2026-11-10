-- Up Migration
-- Release 9: owner controls over background processing. A person can PAUSE a whole class of work (AI analysis, or previews) without losing the queue;
-- the worker simply stops claiming those jobs until it is resumed. Jobs themselves are untouched. Cancel and re-prioritise are plain updates of queued
-- jobs (the API role may already update its own jobs).
CREATE FUNCTION job_queue(kind text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT CASE WHEN kind IN ('ai.analyze','embed.image','embed.text') THEN 'ai' WHEN kind = 'derive.preview' THEN 'previews' ELSE 'other' END $$;

CREATE TABLE queue_controls (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  queue text NOT NULL CHECK (queue IN ('ai','previews')),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, queue)
);
SELECT secure_user_table('queue_controls', 'SELECT, INSERT, UPDATE');
GRANT EXECUTE ON FUNCTION job_queue(text) TO pv_app, pv_service, pv_backup;

CREATE OR REPLACE FUNCTION claim_jobs(p_worker text, p_kinds text[], p_limit integer, p_lease interval)
RETURNS SETOF jobs LANGUAGE plpgsql AS
$$ BEGIN
  UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
                  locked_by = NULL, locked_until = NULL,
                  last_error = coalesce(last_error, 'lease expired'),
                  finished_at = CASE WHEN attempts >= max_attempts THEN now() END
   WHERE state = 'RUNNING' AND locked_until < now();
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM jobs
     WHERE state = 'QUEUED' AND run_after <= now() AND kind = ANY (p_kinds)
       AND NOT EXISTS (SELECT 1 FROM queue_controls c WHERE c.user_id = jobs.user_id AND c.paused AND c.queue = job_queue(jobs.kind))
     ORDER BY priority DESC, run_after
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET state = 'RUNNING', attempts = j.attempts + 1, locked_by = p_worker,
                    locked_until = now() + p_lease
    FROM picked WHERE j.id = picked.id
  RETURNING j.*;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION claim_jobs(p_worker text, p_kinds text[], p_limit integer, p_lease interval)
RETURNS SETOF jobs LANGUAGE plpgsql AS
$$ BEGIN
  UPDATE jobs SET state = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
                  locked_by = NULL, locked_until = NULL,
                  last_error = coalesce(last_error, 'lease expired'),
                  finished_at = CASE WHEN attempts >= max_attempts THEN now() END
   WHERE state = 'RUNNING' AND locked_until < now();
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM jobs
     WHERE state = 'QUEUED' AND run_after <= now() AND kind = ANY (p_kinds)
     ORDER BY priority DESC, run_after
     LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET state = 'RUNNING', attempts = j.attempts + 1, locked_by = p_worker,
                    locked_until = now() + p_lease
    FROM picked WHERE j.id = picked.id
  RETURNING j.*;
END $$;
DROP TABLE queue_controls;
DROP FUNCTION job_queue(text);
