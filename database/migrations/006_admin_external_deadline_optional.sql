-- Allow official admin-curated external listings to preserve unknown source data.
-- Recruiter listings and internal applications still require deadline and work mode.
-- This migration changes constraints only; it does not update or delete any rows.
ALTER TABLE jobs ALTER COLUMN deadline DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN work_mode DROP NOT NULL;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='jobs_admin_external_deadline_policy_check'
          AND conrelid='jobs'::regclass
    ) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_admin_external_deadline_policy_check CHECK (
            deadline IS NOT NULL OR (
                owner_type='ADMIN' AND application_mode='external' AND source_url IS NOT NULL
                AND source_classification IN ('ADMIN_CURATED_VERIFIED','ADMIN_CURATED_PROGRAM')
            )
        );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname='jobs_admin_external_work_mode_policy_check'
          AND conrelid='jobs'::regclass
    ) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_admin_external_work_mode_policy_check CHECK (
            work_mode IS NOT NULL OR (
                owner_type='ADMIN' AND application_mode='external' AND source_url IS NOT NULL
                AND source_classification IN ('ADMIN_CURATED_VERIFIED','ADMIN_CURATED_PROGRAM')
            )
        );
    END IF;
END $$;
