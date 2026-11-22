from backend.application_workflow import (
    APPLICATION_STATUSES,
    RECRUITER_TRANSITIONS,
    can_candidate_withdraw,
    can_recruiter_transition,
)


def test_lifecycle_has_existing_and_new_statuses():
    assert APPLICATION_STATUSES == (
        "submitted", "under_review", "shortlisted", "interview",
        "selected", "rejected", "withdrawn",
    )


def test_recruiter_transitions_follow_the_review_pipeline():
    assert can_recruiter_transition("submitted", "under_review")
    assert can_recruiter_transition("submitted", "rejected")
    assert can_recruiter_transition("under_review", "shortlisted")
    assert can_recruiter_transition("shortlisted", "interview")
    assert can_recruiter_transition("interview", "selected")
    assert can_recruiter_transition("interview", "rejected")
    assert not can_recruiter_transition("shortlisted", "selected")
    assert not can_recruiter_transition("rejected", "under_review")
    assert not can_recruiter_transition("withdrawn", "under_review")
    assert not can_recruiter_transition("selected", "rejected")


def test_terminal_states_have_no_recruiter_transitions():
    assert RECRUITER_TRANSITIONS["selected"] == frozenset()
    assert RECRUITER_TRANSITIONS["rejected"] == frozenset()
    assert RECRUITER_TRANSITIONS["withdrawn"] == frozenset()


def test_candidate_withdrawal_stops_before_interview():
    assert can_candidate_withdraw("submitted")
    assert can_candidate_withdraw("under_review")
    assert can_candidate_withdraw("shortlisted")
    assert not can_candidate_withdraw("interview")
    assert not can_candidate_withdraw("selected")
    assert not can_candidate_withdraw("rejected")
    assert not can_candidate_withdraw("withdrawn")
