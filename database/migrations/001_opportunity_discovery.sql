-- Safe additive migration for Opportunity Discovery. Review and back up before applying.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS opportunity_category VARCHAR(40) NOT NULL DEFAULT 'job';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_level VARCHAR(30) NOT NULL DEFAULT 'Student';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paid_status VARCHAR(20) NOT NULL DEFAULT 'paid';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS eligibility TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS duration VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS application_url VARCHAR(500);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS positions INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source VARCHAR(100) NOT NULL DEFAULT 'recruiter';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS demo_key VARCHAR(80);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_opportunity_category_check') THEN
  ALTER TABLE jobs ADD CONSTRAINT jobs_opportunity_category_check CHECK (opportunity_category IN ('job','internship','hackathon','project','open_source','research','scholarship','fellowship','competition','workshop','developer_program','startup','apprenticeship','certification'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_experience_level_check') THEN
  ALTER TABLE jobs ADD CONSTRAINT jobs_experience_level_check CHECK (experience_level IN ('Beginner','Intermediate','Advanced','Student','Fresher'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_paid_status_check') THEN
  ALTER TABLE jobs ADD CONSTRAINT jobs_paid_status_check CHECK (paid_status IN ('paid','unpaid','stipend','prize','none'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='jobs_positions_check') THEN
  ALTER TABLE jobs ADD CONSTRAINT jobs_positions_check CHECK (positions IS NULL OR positions > 0);
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_demo_key ON jobs(demo_key) WHERE demo_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_discovery ON jobs(status, opportunity_category, deadline, created_at DESC);
