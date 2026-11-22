-- Stage 10: recipient-scoped in-app notifications.
-- Apply after 007_application_workflow.sql and before deploying Stage 10 code.
BEGIN;

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    recipient_user_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    notification_type VARCHAR(40) NOT NULL CHECK (notification_type IN (
        'application_submitted', 'new_applicant', 'application_under_review',
        'application_shortlisted', 'application_interview', 'application_selected',
        'application_rejected', 'application_withdrawn'
    )),
    title VARCHAR(120) NOT NULL,
    message TEXT NOT NULL,
    related_application_id INT REFERENCES applications(id) ON DELETE SET NULL,
    related_job_id INT REFERENCES jobs(id) ON DELETE SET NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT ck_notifications_read_state CHECK (is_read = (read_at IS NOT NULL)),
    CONSTRAINT uq_notifications_recipient_event
        UNIQUE (recipient_user_id, notification_type, related_application_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
    ON notifications (recipient_user_id, created_at DESC, id DESC);
-- Composite key supports recipient-scoped unread queries without a partial-index predicate.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications (recipient_user_id, is_read, created_at DESC, id DESC);

COMMIT;
