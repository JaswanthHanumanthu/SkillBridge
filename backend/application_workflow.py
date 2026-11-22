"""Shared application lifecycle rules used by API handlers and tests."""

APPLICATION_STATUSES = (
    "submitted",
    "under_review",
    "shortlisted",
    "interview",
    "selected",
    "rejected",
    "withdrawn",
)

RECRUITER_TRANSITIONS = {
    "submitted": frozenset({"under_review", "rejected"}),
    "under_review": frozenset({"shortlisted", "rejected"}),
    "shortlisted": frozenset({"interview", "rejected"}),
    "interview": frozenset({"selected", "rejected"}),
    "selected": frozenset(),
    "rejected": frozenset(),
    "withdrawn": frozenset(),
}

# Candidate withdrawals are allowed through Shortlisted. Once interviews start,
# the recruiter pipeline is active and the candidate must contact the recruiter.
CANDIDATE_WITHDRAWAL_STATES = frozenset({"submitted", "under_review", "shortlisted"})


def can_recruiter_transition(current_status, new_status):
    """Return whether the requested recruiter transition is in the workflow."""
    return new_status in RECRUITER_TRANSITIONS.get(current_status, frozenset())


def can_candidate_withdraw(current_status):
    """Return whether a candidate may withdraw at the current stage."""
    return current_status in CANDIDATE_WITHDRAWAL_STATES
