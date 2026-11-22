"""Shared lifecycle rules for PostgreSQL DATE deadlines.

Deadlines are inclusive through that calendar day in the database session timezone.
An externally managed administrator listing may have no published close date; it
remains active until the administrator closes it or the source is rechecked.
Recruiter postings continue to require a deadline.
"""


def active_deadline_predicate(alias="j"):
    if not alias.isidentifier():
        raise ValueError("Invalid SQL alias")
    return f"({alias}.deadline IS NULL OR {alias}.deadline >= CURRENT_DATE)"


def is_deadline_expired(cursor, deadline):
    """Return whether a DATE deadline has passed according to PostgreSQL's clock."""
    if deadline is None:
        return False
    cursor.execute("SELECT %s::date < CURRENT_DATE AS expired", (deadline,))
    return bool(cursor.fetchone()["expired"])
