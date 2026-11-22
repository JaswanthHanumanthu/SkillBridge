-- Additive extension for event-specific metadata. Existing jobs, internships,
-- applications and bookmarks remain unchanged.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS hackathon_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_jobs_hackathon_discovery
  ON jobs (status, deadline, created_at DESC)
  WHERE opportunity_category = 'hackathon' AND is_archived = FALSE;
