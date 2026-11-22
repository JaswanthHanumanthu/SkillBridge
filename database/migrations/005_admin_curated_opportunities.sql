-- Stage 7: allow recruiter-owned and administrator-curated opportunities in jobs.
-- This migration is additive and preserves all existing recruiter/company rows.
ALTER TABLE jobs ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN recruiter_id DROP NOT NULL;
ALTER TABLE jobs ALTER COLUMN job_type DROP NOT NULL;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_type VARCHAR(20) NOT NULL DEFAULT 'RECRUITER';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS created_by_admin INT REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS organization_name VARCHAR(200);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS opportunity_type VARCHAR(40);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS eligible_branches TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS application_mode VARCHAR(20) NOT NULL DEFAULT 'internal';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_classification VARCHAR(40);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_url VARCHAR(500);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_verified_by INT REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_verified_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_opportunity_category_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_opportunity_category_check CHECK (opportunity_category IN (
    'job','internship','hackathon','project','open_source','research','scholarship','fellowship',
    'competition','workshop','developer_program','startup','apprenticeship','certification',
    'government','psu','gate','training'
));

ALTER TABLE job_preferences DROP CONSTRAINT IF EXISTS job_preferences_categories_check;
ALTER TABLE job_preferences ADD CONSTRAINT job_preferences_categories_check CHECK (
    preferred_categories <@ ARRAY[
      'job','internship','hackathon','project','open_source','research','scholarship','fellowship',
      'competition','workshop','developer_program','startup','apprenticeship','certification',
      'government','psu','gate','training'
    ]::TEXT[]
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_owner_type_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_owner_type_check CHECK (owner_type IN ('RECRUITER','ADMIN'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_opportunity_type_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_opportunity_type_check CHECK (
            opportunity_type IS NULL OR opportunity_type IN (
                'employment','internship','hackathon','competition','scholarship','research','fellowship',
                'government','psu','gate','workshop','training','program','other'
            )
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_application_mode_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_application_mode_check CHECK (application_mode IN ('internal','external'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_application_mode_url_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_application_mode_url_check CHECK (application_mode <> 'external' OR application_url IS NOT NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_source_classification_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_source_classification_check CHECK (
            source_classification IS NULL OR source_classification IN (
                'ADMIN_CURATED_VERIFIED','ADMIN_CURATED_PROGRAM','ADMIN_DEMO'
            )
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_source_verification_pair_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_source_verification_pair_check CHECK (
            (source_verified_by IS NULL) = (source_verified_at IS NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_owner_identity_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_owner_identity_check CHECK (
            (owner_type='RECRUITER' AND company_id IS NOT NULL AND recruiter_id IS NOT NULL AND created_by_admin IS NULL AND source_classification IS NULL)
            OR
            (owner_type='ADMIN' AND recruiter_id IS NULL AND created_by_admin IS NOT NULL AND source_classification IS NOT NULL AND opportunity_type IS NOT NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_admin_type_fields_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_admin_type_fields_check CHECK (
            owner_type <> 'ADMIN'
            OR ((opportunity_type IN ('employment','internship') AND job_type IS NOT NULL)
                OR (opportunity_type NOT IN ('employment','internship') AND job_type IS NULL))
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_admin_source_details_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_admin_source_details_check CHECK (
            owner_type <> 'ADMIN'
            OR (source_classification='ADMIN_DEMO'
                AND is_sample IS TRUE AND is_verified IS FALSE AND status <> 'published')
            OR (source_classification='ADMIN_CURATED_PROGRAM' AND source_url IS NOT NULL)
            OR (source_classification='ADMIN_CURATED_VERIFIED' AND source_url IS NOT NULL
                AND source_verified_by IS NOT NULL AND source_verified_at IS NOT NULL
                AND is_verified IS TRUE AND is_sample IS FALSE)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_eligible_branches_no_nulls_check' AND conrelid='jobs'::regclass) THEN
        ALTER TABLE jobs ADD CONSTRAINT jobs_eligible_branches_no_nulls_check CHECK (
            array_position(eligible_branches, NULL) IS NULL
        );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_jobs_owner_status_deadline ON jobs(owner_type,status,deadline);
CREATE INDEX IF NOT EXISTS idx_jobs_admin_creator ON jobs(created_by_admin,created_at DESC) WHERE created_by_admin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_source_classification ON jobs(source_classification,status) WHERE source_classification IS NOT NULL;
