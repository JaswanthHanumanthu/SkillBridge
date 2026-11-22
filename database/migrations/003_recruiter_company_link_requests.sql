-- Additive Stage 5 migration: admin-mediated recruiter/company linking.
-- Existing accounts, companies, recruiter profiles, and applications are unchanged.
CREATE TABLE IF NOT EXISTS recruiter_company_link_requests (
    id SERIAL PRIMARY KEY,
    account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    company_id INT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    requested_full_name VARCHAR(100) NOT NULL,
    requested_email VARCHAR(120),
    requested_phone VARCHAR(30),
    requested_designation VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by INT REFERENCES accounts(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiter_link_one_pending_per_account
    ON recruiter_company_link_requests(account_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_recruiter_link_company_status
    ON recruiter_company_link_requests(company_id, status, created_at DESC);
