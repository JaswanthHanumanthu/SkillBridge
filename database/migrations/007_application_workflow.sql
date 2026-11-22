-- Stage 9: extend the existing application lifecycle without replacing records.
-- Run after migrations 001-006. This migration is safe to rerun.
BEGIN;

ALTER TABLE applications
    DROP CONSTRAINT IF EXISTS applications_current_status_check;
ALTER TABLE applications
    ADD CONSTRAINT applications_current_status_check
    CHECK (current_status IN (
        'submitted', 'under_review', 'shortlisted', 'interview',
        'selected', 'rejected', 'withdrawn'
    ));

ALTER TABLE application_status_history
    DROP CONSTRAINT IF EXISTS application_status_history_status_check;
ALTER TABLE application_status_history
    ADD CONSTRAINT application_status_history_status_check
    CHECK (status IN (
        'submitted', 'under_review', 'shortlisted', 'interview',
        'selected', 'rejected', 'withdrawn'
    ));

ALTER TABLE application_status_history
    ADD COLUMN IF NOT EXISTS previous_status VARCHAR(20);

ALTER TABLE application_status_history
    DROP CONSTRAINT IF EXISTS application_status_history_previous_status_check;
ALTER TABLE application_status_history
    ADD CONSTRAINT application_status_history_previous_status_check
    CHECK (previous_status IS NULL OR previous_status IN (
        'submitted', 'under_review', 'shortlisted', 'interview',
        'selected', 'rejected', 'withdrawn'
    ));

-- Backfill the prior status for existing history rows where it can be inferred.
WITH ordered_history AS (
    SELECT id,
           LAG(status) OVER (
               PARTITION BY application_id ORDER BY changed_at, id
           ) AS prior_status
    FROM application_status_history
)
UPDATE application_status_history AS history
SET previous_status = ordered_history.prior_status
FROM ordered_history
WHERE history.id = ordered_history.id
  AND history.previous_status IS NULL
  AND ordered_history.prior_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_applications_status_applied
    ON applications (current_status, applied_at DESC);

COMMIT;
