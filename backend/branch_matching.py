"""Branch normalization and eligibility rules shared by opportunity routes."""

import re


_BRANCH_ALIASES = {
    "cse": {
        "cse", "cs", "computer science", "computer science engineering",
        "computer science and engineering", "computer engineering",
    },
    "it": {"it", "information technology", "information technology engineering"},
    "ece": {
        "ece", "electronics communication", "electronics and communication",
        "electronics and communication engineering", "electronics communication engineering",
        "electronics telecommunication", "electronics and telecommunication engineering",
    },
    "eee": {
        "eee", "electrical electronics", "electrical and electronics",
        "electrical and electronics engineering", "electrical electronics engineering",
    },
    "mechanical": {"me", "mechanical", "mechanical engineering"},
    "civil": {"ce", "civil", "civil engineering"},
    "chemical": {"chemical", "chemical engineering"},
    "biotechnology": {"biotech", "biotechnology", "biotechnology engineering"},
    "aerospace": {"aerospace", "aerospace engineering", "aeronautical engineering"},
    "instrumentation": {"instrumentation", "instrumentation engineering", "instrumentation and control engineering"},
    "automobile": {"automobile", "automobile engineering", "automotive engineering"},
}

_UNRESTRICTED = {"all", "allbranches", "alldisciplines", "any", "anybranch", "anydiscipline", "openforall"}
_ELIGIBILITY_UNKNOWN = {"unknown", "unspecified", "eligibilityvaries", "roleeligibilityvaries", "checkofficialcriteria"}


def compact_branch(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").casefold())


_ALIAS_TO_CANONICAL = {
    compact_branch(alias): canonical
    for canonical, aliases in _BRANCH_ALIASES.items()
    for alias in aliases
}


def branch_keys(value):
    """Return normalized keys that should compare as the same known branch."""
    key = compact_branch(value)
    if not key or key in _ELIGIBILITY_UNKNOWN or key in _UNRESTRICTED:
        return set()
    canonical = _ALIAS_TO_CANONICAL.get(key)
    if canonical:
        return {compact_branch(alias) for alias in _BRANCH_ALIASES[canonical]}
    return {key}


def is_unrestricted(eligible_branches):
    branches = eligible_branches or []
    return not branches or any(compact_branch(branch) in _UNRESTRICTED for branch in branches)


def is_eligibility_unknown(eligible_branches):
    return any(compact_branch(branch) in _ELIGIBILITY_UNKNOWN for branch in eligible_branches or [])


def is_branch_eligible(candidate_branch, eligible_branches):
    """An empty/all-branch restriction is open; missing student branch is unknown."""
    if is_unrestricted(eligible_branches):
        return True
    candidate_keys = branch_keys(candidate_branch)
    return bool(candidate_keys and any(branch_keys(value) & candidate_keys for value in eligible_branches or []))


def classify_branch_eligibility(candidate_branch, eligible_branches):
    """Return a user-facing eligibility state without conflating unknown and ineligible."""
    branches = eligible_branches or []
    if is_unrestricted(branches):
        return "all_branches"
    if candidate_branch and is_branch_eligible(candidate_branch, branches):
        return "eligible"
    if is_eligibility_unknown(branches):
        return "eligibility_unknown"
    if not candidate_branch:
        return "branch_unknown"
    return "not_eligible"


def sql_branch_filter(alias, candidate_branch, include_unknown=False):
    """Return a parameterized PostgreSQL predicate and args for branch eligibility."""
    if not alias.isidentifier():
        raise ValueError("Invalid SQL alias")
    unrestricted = sorted(_UNRESTRICTED)
    keys = sorted(branch_keys(candidate_branch))
    predicate = f"""(
        COALESCE(cardinality({alias}.eligible_branches), 0) = 0
        OR EXISTS (
            SELECT 1 FROM unnest({alias}.eligible_branches) AS branch_value
            WHERE regexp_replace(lower(branch_value), '[^a-z0-9]', '', 'g') = ANY(%s)
        )"""
    params = [unrestricted]
    if include_unknown:
        predicate += f"""
        OR EXISTS (
            SELECT 1 FROM unnest({alias}.eligible_branches) AS branch_value
            WHERE regexp_replace(lower(branch_value), '[^a-z0-9]', '', 'g') = ANY(%s)
        )"""
        params.append(sorted(_ELIGIBILITY_UNKNOWN))
    if keys:
        predicate += f"""
        OR EXISTS (
            SELECT 1 FROM unnest({alias}.eligible_branches) AS branch_value
            WHERE regexp_replace(lower(branch_value), '[^a-z0-9]', '', 'g') = ANY(%s)
        )"""
        params.append(keys)
    predicate += ")"
    return predicate, params


def get_candidate_branch(cursor, candidate_id):
    """Use the most recently started education record as the candidate's branch."""
    cursor.execute(
        """SELECT field_of_study FROM education
           WHERE candidate_id = %s AND NULLIF(BTRIM(field_of_study), '') IS NOT NULL
           ORDER BY start_year DESC NULLS LAST, id DESC LIMIT 1""",
        (candidate_id,),
    )
    row = cursor.fetchone()
    return row["field_of_study"].strip() if row and row.get("field_of_study") else None
