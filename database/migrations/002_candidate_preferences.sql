-- Safe, additive migration for persisted candidate opportunity-category preferences.
ALTER TABLE job_preferences
  ADD COLUMN IF NOT EXISTS preferred_categories TEXT[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='job_preferences_categories_check') THEN
    ALTER TABLE job_preferences ADD CONSTRAINT job_preferences_categories_check
      CHECK (preferred_categories <@ ARRAY['job','internship','hackathon','project','open_source','research','scholarship','fellowship','competition','workshop','developer_program','startup','apprenticeship','certification']::TEXT[]);
  END IF;
END $$;
