-- Up Migration
-- Per-photo Instagram state, derived from confirmed/high-confidence matches, drafts and schedules.
-- security_invoker => the caller's RLS applies.
CREATE VIEW photo_instagram_status WITH (security_invoker = true) AS
SELECT
  p.id AS photo_id,
  p.user_id,
  coalesce(m.posted_count, 0) AS posted_count,
  m.last_posted_at,
  EXISTS (SELECT 1 FROM publishing_drafts d WHERE d.photo_id = p.id AND d.state IN ('DRAFT','READY')) AS has_draft,
  EXISTS (SELECT 1 FROM publishing_drafts d JOIN scheduled_publications s ON s.draft_id = d.id
           WHERE d.photo_id = p.id AND s.state IN ('SCHEDULED','PUBLISHING')) AS has_scheduled,
  CASE
    WHEN EXISTS (SELECT 1 FROM publishing_drafts d JOIN scheduled_publications s ON s.draft_id = d.id
                  WHERE d.photo_id = p.id AND s.state IN ('SCHEDULED','PUBLISHING')) THEN 'SCHEDULED'
    WHEN EXISTS (SELECT 1 FROM publishing_drafts d WHERE d.photo_id = p.id AND d.state IN ('DRAFT','READY')) THEN 'DRAFT'
    WHEN coalesce(m.posted_count, 0) > 0 THEN 'POSTED'
    ELSE 'NEVER_POSTED'
  END AS status
FROM photos p
LEFT JOIN LATERAL (
  SELECT count(DISTINCT sp.id)::int AS posted_count, max(sp.posted_at) AS last_posted_at
    FROM photo_social_matches psm
    JOIN social_post_media spm ON spm.id = psm.social_post_media_id
    JOIN social_posts sp ON sp.id = spm.social_post_id
   WHERE psm.photo_id = p.id AND psm.state IN ('EXACT_MATCH','HIGH_CONFIDENCE_MATCH','USER_CONFIRMED')
) m ON true
WHERE p.deleted_at IS NULL;

GRANT SELECT ON photo_instagram_status TO pv_app, pv_service, pv_backup;

-- Down Migration
DROP VIEW photo_instagram_status;
