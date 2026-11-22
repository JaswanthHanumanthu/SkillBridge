import os
import math
import re
import uuid
from datetime import date
from backend.fastapi_compat import Blueprint, request, jsonify, session, current_app
from werkzeug.utils import secure_filename
import time
from backend.db import get_db
from backend.config import Config
from backend.utils import role_required, clean_record, allowed_file
from backend.opportunity_lifecycle import active_deadline_predicate
from backend.branch_matching import get_candidate_branch, classify_branch_eligibility, sql_branch_filter
from backend.skill_matching import analyze_skill_gap, normalize_skill
from backend.resume_parser import MAX_RESUME_PARSE_BYTES, parse_resume_pdf, validate_pdf_upload
from backend.application_workflow import APPLICATION_STATUSES, can_candidate_withdraw
from backend.notification_service import create_notification
from psycopg2 import errors as pg_errors

candidate_bp = Blueprint("candidate", __name__, url_prefix="/api/candidate")


def _get_candidate_skill_names(cur, candidate_id):
    cur.execute(
        "SELECT s.name FROM candidate_skills cs JOIN skills s ON s.id=cs.skill_id WHERE cs.candidate_id=%s ORDER BY s.name",
        (candidate_id,),
    )
    return [row["name"] for row in cur.fetchall()]


def _attach_skill_gaps(opportunities, candidate_skills):
    for opportunity in opportunities:
        opportunity["skill_gap"] = analyze_skill_gap(
            opportunity.get("required_skills") or opportunity.get("skills_breakdown") or [],
            candidate_skills,
        )
    return opportunities

def _get_candidate_id(cur, account_id):
    """Helper to fetch candidate_id from candidate_profiles for current account."""
    cur.execute("SELECT id FROM candidate_profiles WHERE account_id = %s;", (account_id,))
    row = cur.fetchone()
    if not row:
        raise ValueError("Candidate profile not found for this account.")
    return row["id"]


def _optional_text(value, label, max_length=None):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} must be {max_length} characters or fewer.")
    return value or None


def _parse_education_year(value, label):
    if value in (None, ""):
        return None
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a year between 1950 and 2100.")
    try:
        year = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a year between 1950 and 2100.")
    if str(value).strip() != str(year) or not 1950 <= year <= 2100:
        raise ValueError(f"{label} must be a year between 1950 and 2100.")
    return year


def _parse_iso_date(value, label):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a valid date in YYYY-MM-DD format.")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{label} must be a valid date in YYYY-MM-DD format.")


def _parse_boolean(value, label):
    if isinstance(value, bool):
        return value
    if value in (1, "1", "true", "True", "on", "yes"):
        return True
    if value in (0, "0", "false", "False", "off", "no", None, ""):
        return False
    raise ValueError(f"{label} must be true or false.")


def _validate_date_range(start, end, is_current=False):
    if is_current and end is not None:
        raise ValueError("A current position cannot have an end date.")
    if start and end and end < start:
        raise ValueError("End date must be on or after the start date.")


# -----------------------------------------------------------------------------
# Saved opportunities
# -----------------------------------------------------------------------------
@candidate_bp.route("/saved-jobs", methods=["GET"])
@role_required("user")
def get_saved_jobs():
    """Return this candidate's saved opportunities, including historical ones."""
    try:
        with get_db() as (conn, cur):
            candidate_id = _get_candidate_id(cur, session["account_id"])
            candidate_branch = get_candidate_branch(cur, candidate_id)
            candidate_skills = _get_candidate_skill_names(cur, candidate_id)
            cur.execute(
                """
                SELECT j.id, j.title, j.job_type, j.work_mode, j.location,
                       j.description, j.requirements, j.salary_min, j.salary_max,
                       j.deadline, j.status, j.opportunity_category, j.opportunity_type,
                       j.experience_level, j.paid_status,
                       COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                       c.industry, c.status AS company_status, j.owner_type,
                       j.source_classification,j.source_url,j.source_verified_at,j.is_verified,j.is_sample,
                       j.application_url,j.application_mode,j.eligible_branches,sj.saved_at,
                       (j.deadline < CURRENT_DATE) AS is_expired,
                       COALESCE(
                         JSON_AGG(JSON_BUILD_OBJECT('id', s.id, 'name', s.name,
                           'is_required', js.is_required,
                           'min_proficiency', js.min_proficiency))
                           FILTER (WHERE s.id IS NOT NULL), '[]'::json
                       ) AS required_skills
                FROM saved_jobs sj
                JOIN jobs j ON j.id = sj.job_id
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN job_skills js ON js.job_id = j.id
                LEFT JOIN skills s ON s.id = js.skill_id
                WHERE sj.candidate_id = %s
                GROUP BY j.id, c.id, sj.saved_at
                ORDER BY sj.saved_at DESC, j.id DESC
                """,
                (candidate_id,),
            )
            rows = clean_record(cur.fetchall())
        _attach_skill_gaps(rows, candidate_skills)
        for row in rows:
            row["branch_eligibility"] = classify_branch_eligibility(candidate_branch, row.get("eligible_branches"))
            row["lifecycle_status"] = (
                "expired" if row["status"] == "published" and row["is_expired"]
                else "active" if row["status"] == "published" and (row["owner_type"] == "ADMIN" or row["company_status"] == "approved")
                else row["status"]
            )
            row["is_available"] = row["lifecycle_status"] == "active" and not row["is_expired"] and row["branch_eligibility"] != "not_eligible"
        return jsonify({"saved_jobs": rows}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/saved-jobs", methods=["POST"])
@role_required("user")
def save_job():
    """Save a discoverable opportunity for the authenticated candidate."""
    data = request.get_json() or {}
    job_id = data.get("job_id")
    if isinstance(job_id, bool) or not isinstance(job_id, int) or job_id < 1:
        return jsonify({"error": "A valid job_id is required."}), 400
    try:
        with get_db() as (conn, cur):
            candidate_id = _get_candidate_id(cur, session["account_id"])
            cur.execute(
                "SELECT saved_at FROM saved_jobs WHERE candidate_id = %s AND job_id = %s",
                (candidate_id, job_id),
            )
            existing = cur.fetchone()
            if existing:
                return jsonify({"job_id": job_id, "saved": True, "already_saved": True}), 200
            cur.execute(
                """
                SELECT j.id, j.eligible_branches, (j.deadline < CURRENT_DATE) AS is_expired
                FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
                WHERE j.id = %s AND j.status = 'published'
                  AND (j.owner_type='ADMIN' OR c.status='approved')
                """,
                (job_id,),
            )
            job = cur.fetchone()
            if not job:
                return jsonify({"error": "This opportunity is unavailable."}), 404
            if job["is_expired"]:
                return jsonify({"error": "This opportunity has expired and cannot be saved."}), 410
            cur.execute(
                """
                INSERT INTO saved_jobs (candidate_id, job_id)
                VALUES (%s, %s)
                ON CONFLICT (candidate_id, job_id) DO NOTHING
                RETURNING saved_at
                """,
                (candidate_id, job_id),
            )
            saved = cur.fetchone()
        return jsonify({"job_id": job_id, "saved": True, "already_saved": saved is None}), 201 if saved else 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/saved-jobs/<int:job_id>", methods=["GET"])
@role_required("user")
def get_saved_job_status(job_id):
    """Check saved state without revealing inaccessible opportunity records."""
    try:
        with get_db() as (conn, cur):
            candidate_id = _get_candidate_id(cur, session["account_id"])
            cur.execute(
                """
                SELECT j.id, j.status, j.owner_type,c.status AS company_status,
                       (j.deadline < CURRENT_DATE) AS is_expired,
                       sj.saved_at
                FROM jobs j LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN saved_jobs sj ON sj.job_id = j.id AND sj.candidate_id = %s
                WHERE j.id = %s
                """,
                (candidate_id, job_id),
            )
            row = cur.fetchone()
            if not row or (not row["saved_at"] and (row["status"] != "published" or (row["owner_type"] != "ADMIN" and row["company_status"] != "approved"))):
                return jsonify({"error": "Opportunity not found."}), 404
            lifecycle_status = "expired" if row["status"] == "published" and row["is_expired"] else row["status"]
            return jsonify({
                "job_id": job_id,
                "saved": row["saved_at"] is not None,
                "saved_at": clean_record(row["saved_at"]),
                "is_expired": bool(row["is_expired"]),
                "lifecycle_status": lifecycle_status,
            }), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/saved-jobs/<int:job_id>", methods=["DELETE"])
@role_required("user")
def remove_saved_job(job_id):
    """Remove only the authenticated candidate's bookmark."""
    try:
        with get_db() as (conn, cur):
            candidate_id = _get_candidate_id(cur, session["account_id"])
            cur.execute(
                "DELETE FROM saved_jobs WHERE candidate_id = %s AND job_id = %s RETURNING job_id",
                (candidate_id, job_id),
            )
            removed = cur.fetchone()
        if not removed:
            return jsonify({"error": "Saved opportunity not found."}), 404
        return jsonify({"job_id": job_id, "saved": False}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


# -----------------------------------------------------------------------------
# 1. Profile Management
# -----------------------------------------------------------------------------
@candidate_bp.route("/profile", methods=["GET"])
@role_required("user")
def get_profile():
    """Fetches candidate full profile, including sub-entities."""
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)

            cur.execute("SELECT * FROM candidate_profiles WHERE id = %s;", (cand_id,))
            profile = clean_record(cur.fetchone())

            cur.execute(
                f"""
                SELECT cs.id, cs.skill_id, s.name AS skill_name, s.category, cs.proficiency, cs.years_of_experience
                FROM candidate_skills cs
                JOIN skills s ON s.id = cs.skill_id
                WHERE cs.candidate_id = %s
                ORDER BY s.name ASC;
                """,
                (cand_id,)
            )
            skills = clean_record(cur.fetchall())

            cur.execute("SELECT * FROM education WHERE candidate_id = %s ORDER BY start_year DESC;", (cand_id,))
            education = clean_record(cur.fetchall())

            cur.execute("SELECT * FROM experience WHERE candidate_id = %s ORDER BY start_date DESC;", (cand_id,))
            experience = clean_record(cur.fetchall())

            cur.execute("SELECT * FROM achievements WHERE candidate_id = %s ORDER BY issue_date DESC;", (cand_id,))
            achievements = clean_record(cur.fetchall())

            cur.execute("SELECT * FROM resumes WHERE candidate_id = %s ORDER BY uploaded_at DESC;", (cand_id,))
            resumes = clean_record(cur.fetchall())

            cur.execute("SELECT * FROM job_preferences WHERE candidate_id = %s;", (cand_id,))
            preferences = clean_record(cur.fetchone())

        return jsonify({
            "profile": profile,
            "skills": skills,
            "education": education,
            "experience": experience,
            "achievements": achievements,
            "resumes": resumes,
            "preferences": preferences or {}
        }), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/profile", methods=["PUT"])
@role_required("user")
def update_profile():
    """Updates biographical and contact details for the candidate."""
    account_id = session["account_id"]
    data = request.get_json() or {}

    try:
        full_name = _optional_text(data.get("full_name"), "Full name", 100)
        email = _optional_text(data.get("email"), "Email", 120)
        phone = _optional_text(data.get("phone"), "Phone", 30)
        location = _optional_text(data.get("location"), "Location", 100)
        headline = _optional_text(data.get("headline"), "Headline", 200)
        bio = _optional_text(data.get("bio"), "Bio", 10000)
        portfolio_url = _optional_text(data.get("portfolio_url"), "Portfolio URL", 255)
        github_url = _optional_text(data.get("github_url"), "GitHub URL", 255)
        linkedin_url = _optional_text(data.get("linkedin_url"), "LinkedIn URL", 255)
        if email and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Enter a valid email address.")
        for label, url in (("Portfolio URL", portfolio_url), ("GitHub URL", github_url), ("LinkedIn URL", linkedin_url)):
            if url and not re.match(r"^https?://", url, re.IGNORECASE):
                raise ValueError(f"{label} must start with http:// or https://.")
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                """
                UPDATE candidate_profiles
                SET full_name = COALESCE(%s, full_name),
                    email = %s,
                    phone = %s,
                    location = %s,
                    headline = %s,
                    bio = %s,
                    portfolio_url = %s,
                    github_url = %s,
                    linkedin_url = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING *;
                """,
                (
                    full_name,
                    email,
                    phone,
                    location,
                    headline,
                    bio,
                    portfolio_url,
                    github_url,
                    linkedin_url,
                    cand_id
                )
            )
            updated = clean_record(cur.fetchone())
            session["name"] = updated["full_name"]

        return jsonify({"message": "Profile updated successfully!", "profile": updated}), 200

    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


# -----------------------------------------------------------------------------
# 2. Skills Management
# -----------------------------------------------------------------------------
@candidate_bp.route("/skills", methods=["POST"])
@role_required("user")
def add_skill():
    """Adds a skill to the candidate's profile."""
    account_id = session["account_id"]
    data = request.get_json() or {}
    try:
        skill_name = _optional_text(data.get("skill_name"), "Skill name", 100) or ""
        category = _optional_text(data.get("category", "General"), "Category", 50) or "General"
        proficiency = data.get("proficiency", "Intermediate")
        if proficiency not in {"Beginner", "Intermediate", "Advanced", "Expert"}:
            raise ValueError("Choose a valid proficiency level.")
        years_exp = float(data.get("years_of_experience") or 0)
        if not math.isfinite(years_exp) or not 0 <= years_exp <= 80:
            raise ValueError("Years of experience must be between 0 and 80.")
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    skill_id = data.get("skill_id")
    if skill_id is not None:
        try:
            skill_id = int(skill_id)
            if skill_id < 1: raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Choose a valid skill."}), 400

    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)

            if not skill_id and skill_name:
                target_key = normalize_skill(skill_name)
                cur.execute("SELECT id, name FROM skills ORDER BY id")
                existing_skill = next((row for row in cur.fetchall() if normalize_skill(row["name"]) == target_key), None)
                if existing_skill:
                    skill_id = existing_skill["id"]
                else:
                    cur.execute(
                        "INSERT INTO skills (name, category) VALUES (%s, %s) RETURNING id;",
                        (skill_name, category)
                    )
                    skill_id = cur.fetchone()["id"]

            if not skill_id:
                return jsonify({"error": "Please specify a skill name or ID."}), 400

            # Insert or update candidate skill
            cur.execute(
                """
                INSERT INTO candidate_skills (candidate_id, skill_id, proficiency, years_of_experience)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (candidate_id, skill_id) DO UPDATE
                SET proficiency = EXCLUDED.proficiency,
                    years_of_experience = EXCLUDED.years_of_experience
                RETURNING id;
                """,
                (cand_id, skill_id, proficiency, years_exp)
            )

        return jsonify({"message": "Skill added to profile!"}), 201

    except pg_errors.ForeignKeyViolation:
        return jsonify({"error": "The selected skill no longer exists. Refresh and try again."}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/skills/<int:candidate_skill_id>", methods=["DELETE"])
@role_required("user")
def delete_skill(candidate_skill_id):
    """Removes a skill from the candidate's profile."""
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                "DELETE FROM candidate_skills WHERE id = %s AND candidate_id = %s;",
                (candidate_skill_id, cand_id)
            )
            if cur.rowcount == 0:
                return jsonify({"error": "Skill not found."}), 404
        return jsonify({"message": "Skill removed from profile."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


# -----------------------------------------------------------------------------
# 3. Education, Experience, Achievements
# -----------------------------------------------------------------------------
@candidate_bp.route("/education", methods=["POST"])
@role_required("user")
def add_education():
    account_id = session["account_id"]
    data = request.get_json() or {}
    try:
        institution = _optional_text(data.get("institution"), "Institution", 200)
        degree = _optional_text(data.get("degree"), "Degree", 150)
        if not institution or not degree:
            raise ValueError("Institution and degree are required.")
        field_of_study = _optional_text(data.get("field_of_study"), "Field of study", 150)
        start_year = _parse_education_year(data.get("start_year"), "Start year")
        end_year = _parse_education_year(data.get("end_year"), "End year")
        if start_year and end_year and end_year < start_year:
            raise ValueError("End year must be on or after the start year.")
        grade = _optional_text(data.get("grade"), "Grade", 50)
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                """
                INSERT INTO education (candidate_id, institution, degree, field_of_study, start_year, end_year, grade)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (cand_id, institution, degree, field_of_study, start_year, end_year, grade)
            )
            item = clean_record(cur.fetchone())
        return jsonify({"message": "Education record added!", "education": item}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/education/<int:edu_id>", methods=["DELETE"])
@role_required("user")
def delete_education(edu_id):
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute("DELETE FROM education WHERE id = %s AND candidate_id = %s;", (edu_id, cand_id))
            if cur.rowcount == 0:
                return jsonify({"error": "Education record not found."}), 404
        return jsonify({"message": "Education record deleted."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/education/<int:edu_id>", methods=["PUT"])
@role_required("user")
def update_education(edu_id):
    data=request.get_json() or {}
    try:
        institution = _optional_text(data.get("institution"), "Institution", 200)
        degree = _optional_text(data.get("degree"), "Degree", 150)
        if not institution or not degree:
            raise ValueError("Institution and degree are required.")
        start_year = _parse_education_year(data.get("start_year"), "Start year")
        end_year = _parse_education_year(data.get("end_year"), "End year")
        if start_year and end_year and end_year < start_year:
            raise ValueError("End year must be on or after the start year.")
        with get_db() as (conn,cur):
            cand_id=_get_candidate_id(cur,session["account_id"])
            cur.execute("UPDATE education SET institution=%s,degree=%s,field_of_study=%s,start_year=%s,end_year=%s,grade=%s WHERE id=%s AND candidate_id=%s RETURNING *",(institution,degree,_optional_text(data.get("field_of_study"), "Field of study", 150),start_year,end_year,_optional_text(data.get("grade"), "Grade", 50),edu_id,cand_id))
            row=clean_record(cur.fetchone())
            if not row:return jsonify({"error":"Education record not found."}),404
        return jsonify({"education":row}),200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Education update failed")
        return jsonify({"error":"Unable to update education record."}),500


@candidate_bp.route("/experience", methods=["POST"])
@role_required("user")
def add_experience():
    account_id = session["account_id"]
    data = request.get_json() or {}
    try:
        company_name = _optional_text(data.get("company_name"), "Company name", 150)
        role_title = _optional_text(data.get("role_title"), "Role title", 150)
        if not company_name or not role_title:
            raise ValueError("Company name and role title are required.")
        location = _optional_text(data.get("location"), "Location", 100)
        start_date = _parse_iso_date(data.get("start_date"), "Start date")
        end_date = _parse_iso_date(data.get("end_date"), "End date")
        is_current = _parse_boolean(data.get("is_current", False), "Current position")
        _validate_date_range(start_date, end_date, is_current)
        description = _optional_text(data.get("description"), "Description", 10000)
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                """
                INSERT INTO experience (candidate_id, company_name, role_title, location, start_date, end_date, is_current, description)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (cand_id, company_name, role_title, location, start_date, end_date, is_current, description)
            )
            item = clean_record(cur.fetchone())
        return jsonify({"message": "Experience record added!", "experience": item}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/experience/<int:exp_id>", methods=["DELETE"])
@role_required("user")
def delete_experience(exp_id):
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute("DELETE FROM experience WHERE id = %s AND candidate_id = %s;", (exp_id, cand_id))
            if cur.rowcount == 0:
                return jsonify({"error": "Experience record not found."}), 404
        return jsonify({"message": "Experience record deleted."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/experience/<int:exp_id>", methods=["PUT"])
@role_required("user")
def update_experience(exp_id):
    data=request.get_json() or {}
    try:
        company_name = _optional_text(data.get("company_name"), "Company name", 150)
        role_title = _optional_text(data.get("role_title"), "Role title", 150)
        if not company_name or not role_title:
            raise ValueError("Company name and role title are required.")
        start_date = _parse_iso_date(data.get("start_date"), "Start date")
        end_date = _parse_iso_date(data.get("end_date"), "End date")
        is_current = _parse_boolean(data.get("is_current", False), "Current position")
        _validate_date_range(start_date, end_date, is_current)
        with get_db() as (conn,cur):
            cand_id=_get_candidate_id(cur,session["account_id"])
            cur.execute("UPDATE experience SET company_name=%s,role_title=%s,location=%s,start_date=%s,end_date=%s,is_current=%s,description=%s WHERE id=%s AND candidate_id=%s RETURNING *",(company_name,role_title,_optional_text(data.get("location"), "Location", 100),start_date,end_date,is_current,_optional_text(data.get("description"), "Description", 10000),exp_id,cand_id))
            row=clean_record(cur.fetchone())
            if not row:return jsonify({"error":"Experience record not found."}),404
        return jsonify({"experience":row}),200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Experience update failed")
        return jsonify({"error":"Unable to update experience record."}),500


@candidate_bp.route("/achievements", methods=["POST"])
@role_required("user")
def add_achievement():
    account_id = session["account_id"]
    data = request.get_json() or {}
    try:
        title = _optional_text(data.get("title"), "Achievement title", 200)
        if not title:
            raise ValueError("Achievement title is required.")
        issuer = _optional_text(data.get("issuer"), "Issuer", 150)
        issue_date = _parse_iso_date(data.get("issue_date"), "Issue date")
        description = _optional_text(data.get("description"), "Description", 10000)
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                """
                INSERT INTO achievements (candidate_id, title, issuer, issue_date, description)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (cand_id, title, issuer, issue_date, description)
            )
            item = clean_record(cur.fetchone())
        return jsonify({"message": "Achievement added!", "achievement": item}), 201
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/achievements/<int:ach_id>", methods=["DELETE"])
@role_required("user")
def delete_achievement(ach_id):
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute("DELETE FROM achievements WHERE id = %s AND candidate_id = %s;", (ach_id, cand_id))
            if cur.rowcount == 0:
                return jsonify({"error": "Achievement not found."}), 404
        return jsonify({"message": "Achievement deleted."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/achievements/<int:ach_id>", methods=["PUT"])
@role_required("user")
def update_achievement(ach_id):
    data = request.get_json() or {}
    try:
        title = _optional_text(data.get("title"), "Achievement title", 200)
        if not title:
            raise ValueError("Achievement title is required.")
        issue_date = _parse_iso_date(data.get("issue_date"), "Issue date")
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, session["account_id"])
            cur.execute("UPDATE achievements SET title=%s,issuer=%s,issue_date=%s,description=%s WHERE id=%s AND candidate_id=%s RETURNING *", (title,_optional_text(data.get("issuer"), "Issuer", 150),issue_date,_optional_text(data.get("description"), "Description", 10000),ach_id,cand_id))
            row = clean_record(cur.fetchone())
            if not row:
                return jsonify({"error": "Achievement not found."}), 404
        return jsonify({"achievement": row, "message": "Achievement updated."}), 200
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception:
        current_app.logger.exception("Achievement update failed")
        return jsonify({"error": "Unable to update achievement."}), 500


# -----------------------------------------------------------------------------
# 4. Job Preferences
# -----------------------------------------------------------------------------
@candidate_bp.route("/preferences", methods=["GET", "PUT"])
@role_required("user")
def manage_preferences():
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)

            if request.method == "GET":
                cur.execute("SELECT * FROM job_preferences WHERE candidate_id = %s;", (cand_id,))
                return jsonify(clean_record(cur.fetchone()) or {}), 200

            data = request.get_json() or {}
            preferred_role = _optional_text(data.get("preferred_role"), "Preferred role", 150)
            preferred_location = _optional_text(data.get("preferred_location"), "Preferred location", 150)
            preferred_work_mode = data.get("preferred_work_mode", "Any")
            categories = data.get("preferred_categories") or []
            if not isinstance(categories, list) or any(not isinstance(item, str) for item in categories):
                return jsonify({"error": "Choose one or more valid opportunity categories."}), 400
            valid_categories = {"job","internship","hackathon","project","open_source","research","scholarship","fellowship","competition","workshop","developer_program","startup","apprenticeship","certification","government","psu","gate","training"}
            categories = sorted(set(categories))
            if set(categories) - valid_categories:
                return jsonify({"error": "One or more opportunity categories are invalid."}), 400
            if not isinstance(preferred_work_mode, str) or preferred_work_mode not in {"Any", "Remote", "Hybrid", "On-site"}:
                return jsonify({"error": "Choose a valid work mode."}), 400
            try:
                min_salary = float(data.get("min_expected_salary") or 0)
                if not math.isfinite(min_salary) or min_salary < 0:
                    raise ValueError
            except (TypeError, ValueError):
                return jsonify({"error": "Minimum compensation must be zero or more."}), 400

            cur.execute(
                """
                INSERT INTO job_preferences (candidate_id, preferred_role, preferred_location, preferred_work_mode, min_expected_salary, preferred_categories)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (candidate_id) DO UPDATE
                SET preferred_role = EXCLUDED.preferred_role,
                    preferred_location = EXCLUDED.preferred_location,
                    preferred_work_mode = EXCLUDED.preferred_work_mode,
                    min_expected_salary = EXCLUDED.min_expected_salary,
                    preferred_categories = EXCLUDED.preferred_categories
                RETURNING *;
                """,
                (cand_id, preferred_role, preferred_location, preferred_work_mode, min_salary, categories)
            )
            item = clean_record(cur.fetchone())
        return jsonify({"message": "Job preferences saved!", "preferences": item}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


# -----------------------------------------------------------------------------
# 5. Resume / CV Uploads
# -----------------------------------------------------------------------------
@candidate_bp.route("/resumes/parse", methods=["POST"])
@role_required("user")
def parse_resume_for_profile():
    """Extract profile suggestions from an in-memory PDF; never persists the file or text."""
    if "resume" not in request.files:
        return jsonify({"error": "Attach a PDF resume to extract profile details."}), 400
    file = request.files["resume"]
    if file.size > MAX_RESUME_PARSE_BYTES:
        return jsonify({"error": "PDF resumes must be 5 MB or smaller."}), 413
    payload = file.read()
    try:
        validate_pdf_upload(file.filename, getattr(file, "content_type", ""), payload)
        with get_db() as (conn, cur):
            cur.execute("SELECT name FROM skills ORDER BY name")
            catalog = cur.fetchall()
        extracted = parse_resume_pdf(payload, catalog)
        return jsonify({"message": "Resume processed. Review suggestions before saving.", "extracted": extracted}), 200
    except OverflowError as exc:
        return jsonify({"error": str(exc)}), 413
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    except RuntimeError:
        current_app.logger.error("PDF resume extraction dependency is unavailable.")
        return jsonify({"error": "PDF extraction is unavailable. Install the project requirements and restart the server."}), 503
    except Exception:
        current_app.logger.error("Resume profile extraction failed.")
        return jsonify({"error": "The resume could not be processed. Please try another PDF."}), 500


@candidate_bp.route("/resumes/upload", methods=["POST"])
@role_required("user")
def upload_resume():
    """Uploads a candidate resume file and stores DB reference."""
    account_id = session["account_id"]
    if "resume" not in request.files:
        return jsonify({"error": "No resume file attached to request."}), 400

    file = request.files["resume"]
    if file.filename == "":
        return jsonify({"error": "No file selected."}), 400

    if not allowed_file(file.filename):
        return jsonify({"error": f"Invalid file type. Allowed: {', '.join(Config.ALLOWED_EXTENSIONS)}"}), 400

    original_filename = secure_filename(file.filename)
    max_size = int(getattr(Config, "MAX_CONTENT_LENGTH", 16 * 1024 * 1024))
    if getattr(file, "size", 0) > max_size:
        return jsonify({"error": "Resume exceeds the maximum allowed file size."}), 413
    unique_filename = f"{uuid.uuid4().hex}_{original_filename}"
    save_path = os.path.join(Config.UPLOAD_FOLDER, unique_filename)
    os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
    relative_path = f"uploads/resumes/{unique_filename}"

    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)

            # Check if this is the first resume, if so make default
            cur.execute("SELECT COUNT(*) AS c FROM resumes WHERE candidate_id = %s;", (cand_id,))
            count = cur.fetchone()["c"]
            is_default = (count == 0)

            file.save(save_path)
            file_size = os.path.getsize(save_path)

            cur.execute(
                """
                INSERT INTO resumes (candidate_id, file_name, file_path, file_size, is_default)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING *;
                """,
                (cand_id, original_filename, relative_path, file_size, is_default)
            )
            resume_item = clean_record(cur.fetchone())

        return jsonify({"message": "Resume uploaded successfully!", "resume": resume_item}), 201

    except Exception:
        if os.path.exists(save_path):
            try: os.remove(save_path)
            except OSError: pass
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/resumes/<int:resume_id>/default", methods=["PUT"])
@role_required("user")
def set_default_resume(resume_id):
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute("SELECT id FROM resumes WHERE id = %s AND candidate_id = %s;", (resume_id, cand_id))
            if not cur.fetchone():
                return jsonify({"error": "Resume not found."}), 404
            cur.execute("UPDATE resumes SET is_default = FALSE WHERE candidate_id = %s;", (cand_id,))
            cur.execute("UPDATE resumes SET is_default = TRUE WHERE id = %s AND candidate_id = %s;", (resume_id, cand_id))
        return jsonify({"message": "Default resume updated."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/resumes/<int:resume_id>", methods=["DELETE"])
@role_required("user")
def delete_resume(resume_id):
    account_id = session["account_id"]
    full_path = None
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute("SELECT file_path, is_default FROM resumes WHERE id = %s AND candidate_id = %s;", (resume_id, cand_id))
            r = cur.fetchone()
            if not r:
                return jsonify({"error": "Resume not found."}), 404
            relative = r["file_path"].replace("/", os.sep)
            full_path = os.path.realpath(os.path.join(Config.BASE_DIR, relative))
            upload_root = os.path.realpath(Config.UPLOAD_FOLDER)
            if os.path.commonpath([full_path, upload_root]) != upload_root:
                return jsonify({"error": "Stored resume path is invalid."}), 500
            cur.execute("DELETE FROM resumes WHERE id = %s AND candidate_id = %s;", (resume_id, cand_id))
            if cur.rowcount == 0:
                return jsonify({"error": "Resume not found."}), 404
            if r["is_default"]:
                cur.execute("SELECT id FROM resumes WHERE candidate_id = %s ORDER BY uploaded_at DESC LIMIT 1;", (cand_id,))
                next_resume = cur.fetchone()
                if next_resume:
                    cur.execute("UPDATE resumes SET is_default = FALSE WHERE candidate_id = %s;", (cand_id,))
                    cur.execute("UPDATE resumes SET is_default = TRUE WHERE id = %s AND candidate_id = %s;", (next_resume["id"], cand_id))
        if full_path and os.path.isfile(full_path):
            try: os.remove(full_path)
            except OSError: current_app.logger.warning("Deleted resume record but could not remove its file.")
        return jsonify({"message": "Resume deleted."}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


# -----------------------------------------------------------------------------
# 6. Applications Tracking with Audit Trail
# -----------------------------------------------------------------------------
@candidate_bp.route("/applications", methods=["GET"])
@role_required("user")
def my_applications():
    """Returns the candidate's applications, status counts, and audit timeline."""
    account_id = session["account_id"]
    status_filter = request.args.get("status", "").strip()
    if status_filter and status_filter not in APPLICATION_STATUSES:
        return jsonify({"error": "Choose a valid application status filter."}), 400
    try:
        with get_db() as (conn, cur):
            cand_id = _get_candidate_id(cur, account_id)
            cur.execute(
                "SELECT current_status, COUNT(*) AS count FROM applications WHERE candidate_id=%s GROUP BY current_status",
                (cand_id,),
            )
            status_counts = {status: 0 for status in APPLICATION_STATUSES}
            status_counts.update({row["current_status"]: row["count"] for row in cur.fetchall()})
            query = """
                SELECT
                    a.id AS application_id,
                    a.current_status,
                    a.applied_at,
                    a.cover_letter,
                    j.id AS job_id,
                    j.title AS job_title,
                    j.job_type,
                    j.opportunity_type,
                    j.application_mode,
                    j.application_url,
                    j.work_mode,
                    j.location AS job_location,
                    j.description AS job_description,
                    j.requirements AS job_requirements,
                    j.deadline AS job_deadline,
                    CASE WHEN j.status = 'published' AND j.deadline < CURRENT_DATE THEN 'expired' ELSE j.status END AS opportunity_status,
                    j.salary_min,
                    j.salary_max,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    c.location AS company_location,
                    r.file_name AS resume_file_name,
                    COALESCE(
                        (
                            SELECT JSON_AGG(
                                JSON_BUILD_OBJECT(
                                    'previous_status', ash.previous_status,
                                    'status', ash.status,
                                    'notes', ash.notes,
                                    'changed_by', actor.username,
                                    'changed_at', ash.changed_at
                                ) ORDER BY ash.changed_at ASC, ash.id ASC
                            )
                            FROM application_status_history ash
                            LEFT JOIN accounts actor ON actor.id = ash.changed_by
                            WHERE ash.application_id = a.id
                        ), '[]'::json
                    ) AS status_history
                FROM applications a
                JOIN jobs j ON j.id = a.job_id
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN resumes r ON r.id = a.resume_id
                WHERE a.candidate_id = %s
            """
            params = [cand_id]
            if status_filter:
                query += " AND a.current_status = %s"
                params.append(status_filter)
            query += " ORDER BY a.applied_at DESC"
            cur.execute(
                query,
                tuple(params),
            )
            apps = clean_record(cur.fetchall())

        return jsonify({"applications": apps, "status_counts": status_counts}), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@candidate_bp.route("/applications/<int:app_id>/withdraw", methods=["POST"])
@role_required("user")
def withdraw_application(app_id):
    """Withdraw one of the authenticated candidate's eligible applications."""
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            candidate_id = _get_candidate_id(cur, account_id)
            cur.execute(
                """
                SELECT a.id, a.current_status, a.job_id, j.title,
                       rp.account_id AS recruiter_account_id
                FROM applications a
                JOIN jobs j ON j.id=a.job_id
                LEFT JOIN recruiter_profiles rp ON rp.id=j.recruiter_id
                WHERE a.id=%s AND a.candidate_id=%s
                FOR UPDATE OF a
                """,
                (app_id, candidate_id),
            )
            application = cur.fetchone()
            if not application:
                return jsonify({"error": "Application not found."}), 404
            if not can_candidate_withdraw(application["current_status"]):
                return jsonify({
                    "error": "This application can no longer be withdrawn. Contact the recruiter if you need to leave the interview process."
                }), 409

            previous_status = application["current_status"]
            cur.execute(
                "UPDATE applications SET current_status='withdrawn', updated_at=CURRENT_TIMESTAMP WHERE id=%s",
                (app_id,),
            )
            cur.execute(
                """
                INSERT INTO application_status_history
                    (application_id, previous_status, status, notes, changed_by)
                VALUES (%s, %s, 'withdrawn', 'Candidate withdrew the application.', %s)
                """,
                (app_id, previous_status, account_id),
            )
            if application["recruiter_account_id"] is not None:
                create_notification(
                    cur, application["recruiter_account_id"], "application_withdrawn",
                    app_id, application["job_id"], application["title"],
                )
        return jsonify({"message": "Application withdrawn."}), 200
    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Application withdrawal failed")
        return jsonify({"error": "Unable to withdraw this application right now."}), 500


# -----------------------------------------------------------------------------
# 7. Transparent Skill-Overlap & Preference Recommendations
# -----------------------------------------------------------------------------
@candidate_bp.route("/recommendations", methods=["GET"])
@role_required("user")
def get_recommendations():
    """
    Computes transparent relational SQL skill overlap scores and preference alignments.
    Returns matching percentages, matched skills, and work mode/location matches.
    """
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            cur.execute("SELECT id FROM candidate_profiles WHERE account_id=%s", (account_id,))
            candidate_row = cur.fetchone()
            candidate_branch = get_candidate_branch(cur, candidate_row["id"]) if candidate_row else None
            candidate_skills = _get_candidate_skill_names(cur, candidate_row["id"]) if candidate_row else []
            if candidate_branch:
                branch_clause, branch_params = sql_branch_filter("j", candidate_branch)
            else:
                # Incomplete profiles must still see the feed; identify restricted rows as unknown.
                branch_clause, branch_params = "TRUE", []
            cur.execute(
                f"""
                WITH candidate_info AS (
                    SELECT 
                        cp.id AS cand_id,
                        %s::text AS candidate_branch,
                        jp.preferred_role,
                        jp.preferred_location,
                        jp.preferred_work_mode,
                        jp.min_expected_salary,
                        jp.preferred_categories
                    FROM candidate_profiles cp
                    LEFT JOIN job_preferences jp ON jp.candidate_id = cp.id
                    WHERE cp.account_id = %s
                ),
                job_skill_stats AS (
                    SELECT 
                        j.id AS job_id,
                        COUNT(js.skill_id) AS total_required_skills,
                        COUNT(*) FILTER (WHERE cs.skill_id IS NOT NULL AND
                            CASE cs.proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 0 END >=
                            CASE js.min_proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 2 END
                        ) AS matching_skills_count,
                        COALESCE(SUM(CASE WHEN js.skill_id IS NULL THEN 0 WHEN js.is_required THEN 4 ELSE 1 END), 0) AS total_skill_weight,
                        COALESCE(SUM(CASE WHEN cs.skill_id IS NOT NULL AND
                            CASE cs.proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 0 END >=
                            CASE js.min_proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 2 END
                            THEN CASE WHEN js.is_required THEN 4 ELSE 1 END ELSE 0 END), 0) AS matched_skill_weight,
                        COALESCE(
                            JSON_AGG(
                                JSON_BUILD_OBJECT(
                                    'id', s.id, 
                                    'name', s.name, 
                                    'matched', (cs.skill_id IS NOT NULL AND
                                        CASE cs.proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 0 END >=
                                        CASE js.min_proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 2 END),
                                    'proficiency', cs.proficiency,
                                    'required', js.is_required,
                                    'min_proficiency', js.min_proficiency
                                )
                            ) FILTER (WHERE s.id IS NOT NULL), '[]'::json
                        ) AS skills_breakdown
                    FROM jobs j
                    CROSS JOIN candidate_info ci
                    LEFT JOIN job_skills js ON js.job_id = j.id
                    LEFT JOIN skills s ON s.id = js.skill_id
                    LEFT JOIN candidate_skills cs ON cs.skill_id = js.skill_id AND cs.candidate_id = ci.cand_id
                    WHERE j.status = 'published' AND {active_deadline_predicate('j')}
                      AND (j.owner_type='ADMIN' OR EXISTS (SELECT 1 FROM companies cj WHERE cj.id=j.company_id AND cj.status='approved'))
                      AND {branch_clause}
                    GROUP BY j.id
                )
                SELECT 
                    j.id,
                    j.title,
                    j.job_type,
                    j.opportunity_type,
                    j.work_mode,
                    j.location,
                    j.description,
                    j.salary_min,
                    j.salary_max,
                    j.deadline,
                    CASE WHEN j.deadline IS NULL THEN NULL ELSE GREATEST(j.deadline-CURRENT_DATE,0) END AS days_remaining,
                    j.opportunity_category,
                    j.eligible_branches,
                    ci.candidate_branch,
                    j.owner_type,
                    j.source_classification,
                    j.source_url,
                    j.source_verified_at,
                    j.is_verified,
                    j.application_mode,
                    j.application_url,
                    c.id AS company_id,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    c.industry,
                    c.location AS company_location,
                    jss.total_required_skills,
                    jss.matching_skills_count,
                    CASE WHEN jss.total_skill_weight = 0 THEN NULL
                         ELSE ROUND(100.0 * jss.matched_skill_weight / jss.total_skill_weight, 1) END AS match_percentage,
                    (ci.preferred_work_mode IS NOT NULL AND (ci.preferred_work_mode = 'Any' OR ci.preferred_work_mode = j.work_mode)) AS work_mode_match,
                    (ci.preferred_location IS NOT NULL AND LOWER(j.location) LIKE LOWER('%%' || ci.preferred_location || '%%')) AS location_match,
                    (COALESCE(cardinality(ci.preferred_categories),0)=0 OR j.opportunity_category = ANY(ci.preferred_categories)) AS category_match,
                    (ci.preferred_role IS NULL OR j.title ILIKE '%%' || ci.preferred_role || '%%') AS role_match,
                    (COALESCE(ci.min_expected_salary,0)=0 OR j.salary_max >= ci.min_expected_salary) AS compensation_match,
                    jss.skills_breakdown
                FROM jobs j
                LEFT JOIN companies c ON c.id = j.company_id
                JOIN job_skill_stats jss ON jss.job_id = j.id
                CROSS JOIN candidate_info ci
                WHERE j.status = 'published' AND {active_deadline_predicate('j')}
                  AND (j.owner_type='ADMIN' OR c.status='approved')
                ORDER BY category_match DESC, role_match DESC, work_mode_match DESC, location_match DESC, compensation_match DESC, match_percentage DESC, j.created_at DESC;
                """,
                (candidate_branch, account_id, *branch_params)
            )
            recommendations = clean_record(cur.fetchall())

        for recommendation in recommendations:
            recommendation["branch_eligibility"] = classify_branch_eligibility(candidate_branch, recommendation.get("eligible_branches"))
        _attach_skill_gaps(recommendations, candidate_skills)

        return jsonify({
            "disclaimer": "Skill recommendations are algorithmic guidance based on your profile skills and preferences.",
            "recommendations": recommendations
        }), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500

