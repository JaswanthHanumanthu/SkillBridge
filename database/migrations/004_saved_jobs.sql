-- Additive Stage 6 migration: candidate-owned saved opportunities.
-- Existing opportunity, candidate, and application records remain unchanged.
CREATE TABLE IF NOT EXISTS saved_jobs (
    id SERIAL PRIMARY KEY,
    candidate_id INT NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
    job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    saved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_saved_jobs_candidate_job UNIQUE (candidate_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_jobs_job_id ON saved_jobs(job_id);
