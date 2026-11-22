import pytest

from backend.notification_service import NOTIFICATION_COPY, create_notification


class FakeCursor:
    def __init__(self, rowcount=1):
        self.rowcount = rowcount
        self.query = None
        self.params = None

    def execute(self, query, params):
        self.query = query
        self.params = params


@pytest.mark.parametrize(
    ("notification_type", "expected_title"),
    [
        ("application_submitted", "Application submitted"),
        ("new_applicant", "New applicant"),
        ("application_under_review", "Application under review"),
        ("application_shortlisted", "You have been shortlisted"),
        ("application_interview", "Interview stage"),
        ("application_selected", "You were selected"),
        ("application_rejected", "Application update"),
        ("application_withdrawn", "Application withdrawn"),
    ],
)
def test_notification_content_and_parameterized_deduplicated_insert(notification_type, expected_title):
    cursor = FakeCursor()

    created = create_notification(cursor, 17, notification_type, 44, 12, "Data Engineer")

    assert created is True
    assert cursor.params == (
        17,
        notification_type,
        expected_title,
        NOTIFICATION_COPY[notification_type][1].format(job_title="Data Engineer"),
        44,
        12,
    )
    assert "%s" in cursor.query
    assert "ON CONFLICT (recipient_user_id, notification_type, related_application_id)" in cursor.query


def test_duplicate_notification_is_reported_as_not_created():
    assert create_notification(FakeCursor(rowcount=0), 17, "new_applicant", 44, 12, "Analyst") is False


def test_missing_recipient_does_not_insert():
    cursor = FakeCursor()
    assert create_notification(cursor, None, "new_applicant", 44, 12, "Analyst") is False
    assert cursor.query is None


def test_unknown_notification_type_is_rejected():
    with pytest.raises(ValueError):
        create_notification(FakeCursor(), 17, "unknown_event", 44, 12, "Analyst")
