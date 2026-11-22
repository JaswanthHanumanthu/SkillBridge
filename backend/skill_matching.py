"""Shared, deterministic skill normalization and required-skill gap analysis."""
import re


_ALIASES = {
    "js": "javascript",
    "javascript": "javascript",
    "csharp": "c#",
    "c#": "c#",
    "cpp": "c++",
    "c++": "c++",
    "postgres": "postgresql",
    "postgresql": "postgresql",
}


def normalize_skill(value):
    """Normalize only known aliases; preserve distinct skills as distinct keys."""
    if not isinstance(value, str):
        return ""
    raw = value.strip().casefold()
    key = re.sub(r"[^a-z0-9+#.]", "", raw)
    return _ALIASES.get(key, key)


def analyze_skill_gap(required_skills, candidate_skills):
    """Return a required-only overlap analysis without changing the existing score."""
    candidate_names = []
    candidate_keys = set()
    for item in candidate_skills or []:
        name = item if isinstance(item, str) else (item.get("skill_name") or item.get("name") or "")
        key = normalize_skill(name)
        if key and key not in candidate_keys:
            candidate_keys.add(key)
            candidate_names.append(str(name).strip())

    required = []
    seen = set()
    for item in required_skills or []:
        if not isinstance(item, dict):
            item = {"name": str(item)}
        name = item.get("name") or item.get("skill_name") or ""
        key = normalize_skill(name)
        is_required = item.get("is_required", item.get("required", True))
        if not key or not is_required or key in seen:
            continue
        seen.add(key)
        required.append({
            "name": str(name).strip(),
            "matched": key in candidate_keys,
            "min_proficiency": item.get("min_proficiency"),
        })

    matched = [item["name"] for item in required if item["matched"]]
    missing = [item["name"] for item in required if not item["matched"]]
    total = len(required)
    percentage = round(100 * len(matched) / total, 1) if total else None
    has_profile_skills = bool(candidate_keys)
    if not total:
        message = "This opportunity has no required skills listed."
    elif not has_profile_skills:
        message = "Add technical skills to your profile to personalize this skill gap."
    else:
        message = None
    return {
        "candidate_has_skills": has_profile_skills,
        "required_skills": required,
        "matched_required_skills": matched,
        "missing_required_skills": missing,
        "total_required_skills": total,
        "required_skill_match_percentage": percentage,
        "skill_gap_message": message,
    }
