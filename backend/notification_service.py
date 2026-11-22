"""Transactional in-app notification helpers for application workflow events."""

NOTIFICATION_COPY = {
    "application_submitted": (
        "Application submitted",
        "Your application for ‘{job_title}’ was submitted successfully.",
    ),
    "new_applicant": (
        "New applicant",
        "A candidate submitted an application for ‘{job_title}’.",
    ),
    "application_under_review": (
        "Application under review",
        "Your application for ‘{job_title}’ is now under review.",
    ),
    "application_shortlisted": (
        "You have been shortlisted",
        "Your application for ‘{job_title}’ has been shortlisted.",
    ),
    "application_interview": (
        "Interview stage",
        "Your application for ‘{job_title}’ has moved to the interview stage.",
    ),
    "application_selected": (
        "You were selected",
        "Your application for ‘{job_title}’ was marked as selected.",
    ),
    "application_rejected": (
        "Application update",
        "The recruiter has updated your application for ‘{job_title}’ to Rejected.",
    ),
    "application_withdrawn": (
        "Application withdrawn",
        "A candidate withdrew their application for ‘{job_title}’.",
    ),
}


def create_notification(cur, recipient_user_id, notification_type, application_id, job_id, job_title):
    """Insert one event notification on the caller's current transaction/cursor."""
    if notification_type not in NOTIFICATION_COPY:
        raise ValueError("Unsupported notification type.")
    if recipient_user_id is None:
        return False

    title, message_template = NOTIFICATION_COPY[notification_type]
    cur.execute(
        """
        INSERT INTO notifications
            (recipient_user_id, notification_type, title, message,
             related_application_id, related_job_id)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (recipient_user_id, notification_type, related_application_id)
        DO NOTHING
        """,
        (
            recipient_user_id,
            notification_type,
            title,
            message_template.format(job_title=job_title or "this opportunity"),
            application_id,
            job_id,
        ),
    )
    return cur.rowcount == 1
