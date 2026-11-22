from backend.fastapi_compat import Blueprint, request, jsonify, session, current_app
from datetime import date
import math
import re
from psycopg2 import errors as pg_errors
from backend.db import get_db
from backend.utils import role_required, clean_record
from backend.opportunity_lifecycle import is_deadline_expired
from backend.application_workflow import APPLICATION_STATUSES, can_recruiter_transition
from backend.notification_service import create_notification

recruiter_bp = Blueprint("recruiter", __name__, url_prefix="/api/recruiter")

JOB_TYPES = {"Full-time", "Part-time", "Internship", "Contract"}
WORK_MODES = {"Remote", "Hybrid", "On-site"}
OPPORTUNITY_CATEGORIES = {"job", "internship", "hackathon", "project", "open_source", "research", "scholarship", "fellowship", "competition", "workshop", "developer_program", "startup", "apprenticeship", "certification"}
EXPERIENCE_LEVELS = {"Beginner", "Intermediate", "Advanced", "Student", "Fresher"}
PAID_STATUSES = {"paid", "unpaid", "stipend", "prize", "none"}
PROFICIENCIES = {"Beginner", "Intermediate", "Advanced", "Expert"}


def _text(value, label, max_length, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required.")
    if len(value) > max_length:
        raise ValueError(f"{label} must be {max_length} characters or fewer.")
    return value or None


def _money(value, label):
    try:
        amount = float(value or 0)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a valid non-negative number.")
    if not math.isfinite(amount) or amount < 0:
        raise ValueError(f"{label} must be a valid non-negative number.")
    return amount


def _date_value(value, label):
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a valid date in YYYY-MM-DD format.")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{label} must be a valid date in YYYY-MM-DD format.")


def _validated_skills(items):
    if not isinstance(items, list):
        raise ValueError("skill_ids must be a list.")
    normalized, seen = [], set()
    for item in items:
        if isinstance(item, dict):
            raw_id = item.get("skill_id")
            required = item.get("is_required", True)
            proficiency = item.get("min_proficiency", "Intermediate")
        else:
            raw_id, required, proficiency = item, True, "Intermediate"
        if isinstance(raw_id, bool):
            raise ValueError("Each selected skill must have a valid skill ID.")
        try:
            skill_id = int(raw_id)
        except (TypeError, ValueError):
            raise ValueError("Each selected skill must have a valid skill ID.")
        if skill_id < 1:
            raise ValueError("Each selected skill must have a valid skill ID.")
        if skill_id in seen:
            raise ValueError("A skill can only be selected once per opportunity.")
        if not isinstance(required, bool):
            raise ValueError("Skill classification must be required or optional.")
        if proficiency not in PROFICIENCIES:
            raise ValueError("Choose a valid minimum skill proficiency.")
        seen.add(skill_id)
        normalized.append((skill_id, required, proficiency))
    return normalized

def _get_recruiter_and_company(cur, account_id):
    """Helper to verify recruiter profile and company approved status."""
    cur.execute(
        """
        SELECT rp.id AS recruiter_id, rp.company_id, rp.full_name,
               c.name AS company_name, c.status AS company_status
        FROM recruiter_profiles rp
        JOIN companies c ON c.id = rp.company_id
        WHERE rp.account_id = %s;
        """,
        (account_id,)
    )
    row = cur.fetchone()
    if not row:
        raise ValueError("Recruiter profile not found.")
    if row["company_status"] != "approved":
        raise PermissionError("Your company is not approved. Access is restricted to approved recruiters.")
    return row


@recruiter_bp.route("/company", methods=["GET"])
@role_required("recruiter")
def get_company_details():
    """Returns company info for the logged-in recruiter."""
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)
            cur.execute("SELECT * FROM companies WHERE id = %s;", (rec["company_id"],))
            company = clean_record(cur.fetchone())
        return jsonify({"company": company, "recruiter": clean_record(rec)}), 200
    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/jobs", methods=["GET"])
@role_required("recruiter")
def get_company_jobs():
    """Lists all jobs posted by the recruiter's company, including applicant counts."""
    account_id = session["account_id"]
    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)
            cur.execute(
                """
                SELECT 
                    j.*,
                    CASE WHEN j.status = 'published' AND j.deadline < CURRENT_DATE THEN 'expired' ELSE j.status END AS lifecycle_status,
                    CASE WHEN j.status = 'published' AND j.deadline >= CURRENT_DATE THEN GREATEST(j.deadline - CURRENT_DATE, 0) ELSE NULL END AS days_remaining,
                    COUNT(DISTINCT a.id) AS applicant_count,
                    COALESCE(
                        JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id', s.id, 'name', s.name, 'is_required', js.is_required, 'min_proficiency', js.min_proficiency))
                            FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb
                    ) AS skills
                FROM jobs j
                LEFT JOIN applications a ON a.job_id = j.id
                LEFT JOIN job_skills js ON js.job_id = j.id
                LEFT JOIN skills s ON s.id = js.skill_id
                WHERE j.company_id = %s AND j.owner_type = 'RECRUITER'
                GROUP BY j.id
                ORDER BY j.created_at DESC;
                """,
                (rec["company_id"],)
            )
            jobs = clean_record(cur.fetchall())
        return jsonify({"jobs": jobs}), 200
    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/jobs", methods=["POST"])
@role_required("recruiter")
def create_job():
    """
    Creates a new job opening and attaches required skills within a database transaction.
    """
    account_id = session["account_id"]
    data = request.get_json() or {}

    try:
        title = _text(data.get("title"), "Title", 200, True)
        location = _text(data.get("location"), "Location", 150, True)
        description = _text(data.get("description"), "Description", 50000, True)
        requirements = _text(data.get("requirements"), "Requirements", 50000)
        job_type = data.get("job_type", "Full-time")
        work_mode = data.get("work_mode", "On-site")
        category = data.get("opportunity_category", "job")
        experience_level = data.get("experience_level", "Student")
        paid_status = data.get("paid_status", "paid")
        if job_type not in JOB_TYPES: raise ValueError("Choose a valid opportunity type.")
        if work_mode not in WORK_MODES: raise ValueError("Choose a valid work mode.")
        if category not in OPPORTUNITY_CATEGORIES: raise ValueError("Choose a valid opportunity category.")
        if experience_level not in EXPERIENCE_LEVELS: raise ValueError("Choose a valid experience level.")
        if paid_status not in PAID_STATUSES: raise ValueError("Choose a valid compensation type.")
        deadline_date = _date_value(data.get("deadline"), "Deadline")
        salary_min = _money(data.get("salary_min"), "Minimum compensation")
        salary_max = _money(data.get("salary_max"), "Maximum compensation")
        if salary_max < salary_min:
            raise ValueError("Maximum compensation must be greater than or equal to minimum compensation.")
        status = data.get("status", "published")
        if status not in {"draft", "published"}:
            raise ValueError("New opportunities can be saved as draft or published.")
        eligibility = _text(data.get("eligibility"), "Eligibility", 10000)
        start_date = _date_value(data["start_date"], "Start date") if data.get("start_date") else None
        duration = _text(data.get("duration"), "Duration", 100)
        application_url = _text(data.get("application_url"), "Application URL", 500)
        if application_url and not re.match(r"^https?://", application_url, re.IGNORECASE):
            raise ValueError("Application URL must start with http:// or https://.")
        positions_raw = data.get("positions")
        positions = None
        if positions_raw not in (None, ""):
            if isinstance(positions_raw, bool): raise ValueError("Number of positions must be a positive whole number.")
            positions = int(positions_raw)
            if positions < 1 or str(positions_raw).strip() != str(positions):
                raise ValueError("Number of positions must be a positive whole number.")
        skill_ids = _validated_skills(data.get("skill_ids", []))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        with get_db() as (conn, cur):
            if status == "published" and is_deadline_expired(cur, deadline_date.isoformat()):
                return jsonify({"error": "Choose today or a future date for the application deadline."}), 400
            rec = _get_recruiter_and_company(cur, account_id)
            company_id = rec["company_id"]
            recruiter_id = rec["recruiter_id"]

            cur.execute(
                """
                INSERT INTO jobs (company_id, recruiter_id, title, job_type, work_mode, location,
                                 description, requirements, salary_min, salary_max, deadline, status,
                                 opportunity_category, experience_level, paid_status, eligibility,
                                 start_date, duration, application_url, positions)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id;
                """,
                (company_id, recruiter_id, title, job_type, work_mode, location,
                 description, requirements, salary_min, salary_max, deadline_date, status,
                 category, experience_level, paid_status, eligibility, start_date, duration,
                 application_url, positions)
            )
            job_id = cur.fetchone()["id"]

            for skill_id, is_required, proficiency in skill_ids:
                cur.execute(
                    "INSERT INTO job_skills (job_id, skill_id, is_required, min_proficiency) VALUES (%s, %s, %s, %s);",
                    (job_id, skill_id, is_required, proficiency)
                )

        return jsonify({"message": "Opportunity saved successfully!" if status == "draft" else "Opportunity published successfully!", "job_id": job_id}), 201

    except PermissionError as pe:
        return jsonify({"error": str(pe)}), 403
    except pg_errors.ForeignKeyViolation:
        return jsonify({"error": "One or more selected skills no longer exist. Refresh the skill list and try again."}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/jobs/<int:job_id>", methods=["PUT"])
@role_required("recruiter")
def update_job(job_id):
    """Updates an existing job belonging to recruiter's company."""
    account_id = session["account_id"]
    data = request.get_json() or {}
    if "status" in data:
        return jsonify({"error": "Use the explicit opportunity status action to publish, close, or draft an opportunity."}), 400

    try:
        values = {
            "title": _text(data["title"], "Title", 200, True) if "title" in data else None,
            "job_type": data.get("job_type"),
            "work_mode": data.get("work_mode"),
            "location": _text(data["location"], "Location", 150, True) if "location" in data else None,
            "description": _text(data["description"], "Description", 50000, True) if "description" in data else None,
            "requirements": _text(data["requirements"], "Requirements", 50000) if "requirements" in data else None,
            "salary_min": _money(data["salary_min"], "Minimum compensation") if "salary_min" in data else None,
            "salary_max": _money(data["salary_max"], "Maximum compensation") if "salary_max" in data else None,
            "deadline": _date_value(data["deadline"], "Deadline") if "deadline" in data else None,
            "opportunity_category": data.get("opportunity_category"),
            "experience_level": data.get("experience_level"),
            "paid_status": data.get("paid_status"),
            "eligibility": _text(data["eligibility"], "Eligibility", 10000) if "eligibility" in data else None,
            "start_date": _date_value(data["start_date"], "Start date") if data.get("start_date") else None,
            "duration": _text(data["duration"], "Duration", 100) if "duration" in data else None,
            "application_url": _text(data["application_url"], "Application URL", 500) if "application_url" in data else None,
            "positions": None,
        }
        for key, allowed, label in (("job_type", JOB_TYPES, "opportunity type"), ("work_mode", WORK_MODES, "work mode"), ("opportunity_category", OPPORTUNITY_CATEGORIES, "opportunity category"), ("experience_level", EXPERIENCE_LEVELS, "experience level"), ("paid_status", PAID_STATUSES, "compensation type")):
            if key in data and values[key] not in allowed:
                raise ValueError(f"Choose a valid {label}.")
        if values["application_url"] and not re.match(r"^https?://", values["application_url"], re.IGNORECASE):
            raise ValueError("Application URL must start with http:// or https://.")
        if "positions" in data and data["positions"] not in (None, ""):
            raw_positions = data["positions"]
            if isinstance(raw_positions, bool): raise ValueError("Number of positions must be a positive whole number.")
            values["positions"] = int(raw_positions)
            if values["positions"] < 1 or str(raw_positions).strip() != str(values["positions"]):
                raise ValueError("Number of positions must be a positive whole number.")
        normalized_skills = _validated_skills(data["skill_ids"]) if "skill_ids" in data else None
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)

            cur.execute("SELECT id, deadline, status, salary_min, salary_max FROM jobs WHERE id = %s AND company_id = %s AND owner_type = 'RECRUITER' FOR UPDATE;", (job_id, rec["company_id"]))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "Job not found or does not belong to your company."}), 404
            new_min = values["salary_min"] if "salary_min" in data else existing["salary_min"]
            new_max = values["salary_max"] if "salary_max" in data else existing["salary_max"]
            if new_max < new_min:
                return jsonify({"error": "Maximum compensation must be greater than or equal to minimum compensation."}), 400
            if existing["status"] == "published" and is_deadline_expired(cur, existing["deadline"]) and "deadline" in data:
                return jsonify({"error": "Use the explicit renew action to publish an expired opportunity with a new deadline."}), 400
            effective_deadline = values["deadline"] if "deadline" in data else existing["deadline"]
            if existing["status"] == "published" and is_deadline_expired(cur, effective_deadline):
                return jsonify({"error": "An expired opportunity cannot remain published. Use the explicit renewal action with a new deadline."}), 400

            cur.execute(
                """
                UPDATE jobs
                SET title = COALESCE(%s, title),
                    job_type = COALESCE(%s, job_type),
                    work_mode = COALESCE(%s, work_mode),
                    location = COALESCE(%s, location),
                    description = COALESCE(%s, description),
                    requirements = COALESCE(%s, requirements),
                    salary_min = COALESCE(%s, salary_min),
                    salary_max = COALESCE(%s, salary_max),
                    deadline = COALESCE(%s, deadline),
                    opportunity_category = COALESCE(%s, opportunity_category),
                    experience_level = COALESCE(%s, experience_level),
                    paid_status = COALESCE(%s, paid_status),
                    eligibility = COALESCE(%s, eligibility),
                    start_date = COALESCE(%s, start_date),
                    duration = COALESCE(%s, duration),
                    application_url = COALESCE(%s, application_url),
                    positions = COALESCE(%s, positions),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s AND company_id = %s AND owner_type = 'RECRUITER'
                RETURNING *;
                """,
                (
                    values["title"], values["job_type"], values["work_mode"], values["location"],
                    values["description"], values["requirements"], values["salary_min"], values["salary_max"],
                    values["deadline"], values["opportunity_category"], values["experience_level"],
                    values["paid_status"], values["eligibility"], values["start_date"], values["duration"],
                    values["application_url"], values["positions"],
                    job_id,
                    rec["company_id"]
                )
            )
            updated = clean_record(cur.fetchone())
            if normalized_skills is not None:
                cur.execute("DELETE FROM job_skills WHERE job_id=%s", (job_id,))
                for skill_id, required, proficiency in normalized_skills:
                    cur.execute("INSERT INTO job_skills(job_id,skill_id,is_required,min_proficiency) VALUES(%s,%s,%s,%s)", (job_id, skill_id, required, proficiency))

        return jsonify({"message": "Job updated successfully!", "job": updated}), 200

    except PermissionError as pe:
        return jsonify({"error": str(pe)}), 403
    except pg_errors.ForeignKeyViolation:
        return jsonify({"error": "One or more selected skills no longer exist. Refresh the skill list and try again."}), 400
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/jobs/<int:job_id>/status", methods=["PATCH"])
@role_required("recruiter")
def toggle_job_status(job_id):
    """Toggles job status between 'published' and 'closed'."""
    account_id = session["account_id"]
    data = request.get_json() or {}
    new_status = data.get("status")

    if new_status not in ("published", "closed", "draft"):
        return jsonify({"error": "Status must be 'published', 'closed', or 'draft'."}), 400

    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)
            cur.execute("SELECT deadline FROM jobs WHERE id=%s AND company_id=%s AND owner_type='RECRUITER'", (job_id, rec["company_id"]))
            lifecycle = cur.fetchone()
            if not lifecycle:
                return jsonify({"error": "Job not found or unauthorized."}), 404
            if new_status == "published" and is_deadline_expired(cur, lifecycle["deadline"]):
                return jsonify({"error": "This opportunity has expired. Update its deadline before reopening it."}), 400
            cur.execute(
                "UPDATE jobs SET status = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s AND company_id = %s AND owner_type='RECRUITER' RETURNING id, status;",
                (new_status, job_id, rec["company_id"])
            )
            row = cur.fetchone()
            if not row:
                return jsonify({"error": "Job not found or unauthorized."}), 404

        return jsonify({"message": f"Job status changed to {new_status}."}), 200

    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/jobs/<int:job_id>/renew", methods=["POST"])
@role_required("recruiter")
def renew_job(job_id):
    """Explicitly renew an expired published job with a new future deadline."""
    data = request.get_json() or {}
    try:
        new_deadline = date.fromisoformat(data.get("deadline", ""))
    except (TypeError, ValueError):
        return jsonify({"error": "Provide a valid new deadline in YYYY-MM-DD format."}), 400
    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, session["account_id"])
            cur.execute("SELECT deadline, status FROM jobs WHERE id=%s AND company_id=%s AND owner_type='RECRUITER' FOR UPDATE", (job_id, rec["company_id"]))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "Job not found or unauthorized."}), 404
            if existing["status"] != "published" or not is_deadline_expired(cur, existing["deadline"]):
                return jsonify({"error": "Only expired published opportunities can be renewed."}), 409
            if is_deadline_expired(cur, new_deadline.isoformat()):
                return jsonify({"error": "The new deadline must be today or a future date."}), 400
            cur.execute("UPDATE jobs SET deadline=%s, updated_at=CURRENT_TIMESTAMP WHERE id=%s AND company_id=%s AND owner_type='RECRUITER' RETURNING id, deadline", (new_deadline.isoformat(), job_id, rec["company_id"]))
            updated = clean_record(cur.fetchone())
        return jsonify({"message": "Opportunity renewed and republished.", "job": updated}), 200
    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Opportunity renewal failed")
        return jsonify({"error": "Unable to renew this opportunity right now."}), 500


@recruiter_bp.route("/applicants", methods=["GET"])
@role_required("recruiter")
def get_applicants():
    """
    Returns all applicants for jobs posted by recruiter's company only.
    Includes candidate details, skills, attached resume link, and application status history.
    """
    account_id = session["account_id"]
    job_id_filter = request.args.get("job_id")
    status_filter = request.args.get("status", "").strip()
    search = request.args.get("search", "").strip()
    skill_filter = request.args.get("skill", "").strip()
    education_filter = request.args.get("education", "").strip()
    experience_filter = request.args.get("experience", "").strip()
    has_experience = request.args.get("has_experience") == "true"
    valid_statuses = set(APPLICATION_STATUSES)
    if status_filter and status_filter not in valid_statuses:
        return jsonify({"error": "Choose a valid application status filter."}), 400
    if job_id_filter:
        try:
            job_id_filter = int(job_id_filter)
            if job_id_filter < 1: raise ValueError
        except (TypeError, ValueError):
            return jsonify({"error": "Job ID filter must be a positive whole number."}), 400

    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)
            company_id = rec["company_id"]
            cur.execute(
                """
                SELECT a.current_status, COUNT(*) AS count
                FROM applications a
                JOIN jobs j ON j.id=a.job_id
                WHERE j.company_id=%s AND j.owner_type='RECRUITER'
                GROUP BY a.current_status
                """,
                (company_id,),
            )
            status_counts = {status: 0 for status in APPLICATION_STATUSES}
            status_counts.update({row["current_status"]: row["count"] for row in cur.fetchall()})
            cur.execute(
                "SELECT id AS job_id, title AS job_title FROM jobs WHERE company_id=%s AND owner_type='RECRUITER' ORDER BY title",
                (company_id,),
            )
            opportunities = clean_record(cur.fetchall())

            query = """
                SELECT 
                    a.id AS application_id,
                    a.current_status,
                    a.applied_at,
                    a.cover_letter,
                    j.id AS job_id,
                    j.title AS job_title,
                    cp.id AS candidate_id,
                    cp.full_name AS candidate_name,
                    cp.email AS candidate_email,
                    cp.phone AS candidate_phone,
                    cp.headline AS candidate_headline,
                    cp.bio AS candidate_bio,
                    cp.location AS candidate_location,
                    r.id AS resume_id,
                    r.file_name AS resume_file_name,
                    r.file_path AS resume_file_path,
                    COALESCE(
                        JSON_AGG(
                            JSON_BUILD_OBJECT('skill', s.name, 'proficiency', cs.proficiency)
                        ) FILTER (WHERE s.id IS NOT NULL), '[]'::json
                    ) AS candidate_skills,
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
                            LEFT JOIN accounts actor ON actor.id=ash.changed_by
                            WHERE ash.application_id = a.id
                        ), '[]'::json
                    ) AS status_history
                    , COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('institution',e.institution,'degree',e.degree,'field_of_study',e.field_of_study,'start_year',e.start_year,'end_year',e.end_year,'grade',e.grade) ORDER BY e.start_year DESC) FROM education e WHERE e.candidate_id=cp.id),'[]'::json) AS education
                    , COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('role_title',x.role_title,'company_name',x.company_name,'location',x.location,'start_date',x.start_date,'end_date',x.end_date,'is_current',x.is_current,'description',x.description) ORDER BY x.start_date DESC) FROM experience x WHERE x.candidate_id=cp.id),'[]'::json) AS experience
                    , COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('title',ach.title,'issuer',ach.issuer,'issue_date',ach.issue_date,'description',ach.description) ORDER BY ach.issue_date DESC) FROM achievements ach WHERE ach.candidate_id=cp.id),'[]'::json) AS achievements
                FROM applications a
                JOIN jobs j ON j.id = a.job_id
                JOIN candidate_profiles cp ON cp.id = a.candidate_id
                LEFT JOIN resumes r ON r.id = a.resume_id
                LEFT JOIN candidate_skills cs ON cs.candidate_id = cp.id
                LEFT JOIN skills s ON s.id = cs.skill_id
                WHERE j.company_id = %s AND j.owner_type = 'RECRUITER'
            """
            params = [company_id]

            if job_id_filter:
                query += " AND j.id = %s"
                params.append(job_id_filter)
            if status_filter:
                query += " AND a.current_status = %s"
                params.append(status_filter)
            if search:
                query += " AND LOWER(cp.full_name) LIKE LOWER(%s)"
                params.append(f"%{search}%")
            if skill_filter:
                query += " AND EXISTS (SELECT 1 FROM candidate_skills cfilter JOIN skills sfilter ON sfilter.id=cfilter.skill_id WHERE cfilter.candidate_id=cp.id AND LOWER(sfilter.name) LIKE LOWER(%s))"
                params.append(f"%{skill_filter}%")
            if has_experience:
                query += " AND EXISTS (SELECT 1 FROM experience xfilter WHERE xfilter.candidate_id=cp.id)"
            if experience_filter:
                query += " AND EXISTS (SELECT 1 FROM experience xfilter WHERE xfilter.candidate_id=cp.id AND LOWER(xfilter.role_title || ' ' || xfilter.company_name || ' ' || COALESCE(xfilter.description,'')) LIKE LOWER(%s))"
                params.append(f"%{experience_filter}%")
            if education_filter:
                query += " AND EXISTS (SELECT 1 FROM education efilter WHERE efilter.candidate_id=cp.id AND LOWER(efilter.institution || ' ' || efilter.degree || ' ' || COALESCE(efilter.field_of_study,'')) LIKE LOWER(%s))"
                params.append(f"%{education_filter}%")

            query += " GROUP BY a.id, j.id, cp.id, r.id ORDER BY a.applied_at DESC;"

            cur.execute(query, tuple(params))
            applicants = clean_record(cur.fetchall())

        return jsonify({
            "applicants": applicants,
            "status_counts": status_counts,
            "opportunities": opportunities,
        }), 200

    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@recruiter_bp.route("/applications/<int:app_id>/status", methods=["PUT"])
@role_required("recruiter")
def update_application_status(app_id):
    """
    Updates application status (under_review, shortlisted, rejected, selected)
    and records an audit entry in application_status_history.
    """
    account_id = session["account_id"]
    data = request.get_json() or {}
    new_status = data.get("status")
    notes = data.get("notes") or ""
    if not isinstance(notes, str) or len(notes) > 5000:
        return jsonify({"error": "Recruiter notes must be text with no more than 5,000 characters."}), 400
    notes = notes.strip()

    if not isinstance(new_status, str) or new_status not in APPLICATION_STATUSES:
        return jsonify({"error": f"Invalid status. Must be one of: {', '.join(APPLICATION_STATUSES)}"}), 400

    try:
        with get_db() as (conn, cur):
            rec = _get_recruiter_and_company(cur, account_id)

            # Ensure application belongs to recruiter's company
            cur.execute(
                """
                SELECT a.id, a.current_status, a.job_id, j.title,
                       cp.account_id AS candidate_account_id
                FROM applications a
                JOIN jobs j ON j.id = a.job_id
                JOIN candidate_profiles cp ON cp.id=a.candidate_id
                WHERE a.id = %s AND j.company_id = %s AND j.owner_type = 'RECRUITER'
                FOR UPDATE OF a;
                """,
                (app_id, rec["company_id"])
            )
            app = cur.fetchone()
            if not app:
                return jsonify({"error": "Application not found or unauthorized."}), 404
            if not can_recruiter_transition(app["current_status"], new_status):
                return jsonify({"error": f"Cannot move an application from {app['current_status']} to {new_status}."}), 409

            # Update application current_status
            cur.execute(
                """
                UPDATE applications
                SET current_status = %s, updated_at = CURRENT_TIMESTAMP
                WHERE id = %s;
                """,
                (new_status, app_id)
            )

            # Insert history audit record
            cur.execute(
                """
                INSERT INTO application_status_history
                    (application_id, previous_status, status, notes, changed_by)
                VALUES (%s, %s, %s, %s, %s);
                """,
                (app_id, app["current_status"], new_status, notes or f"Status changed to {new_status} by recruiter", account_id)
            )
            create_notification(
                cur, app["candidate_account_id"], f"application_{new_status}",
                app_id, app["job_id"], app["title"],
            )

        return jsonify({"message": f"Application status updated to '{new_status}'."}), 200

    except (ValueError, PermissionError) as pe:
        return jsonify({"error": str(pe)}), 403
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500
