from backend.fastapi_compat import Blueprint, request, jsonify, session, current_app
from backend.db import get_db
from backend.utils import role_required, clean_record
from backend.opportunity_lifecycle import is_deadline_expired
from psycopg2 import errors as pg_errors
from datetime import date
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit
from backend.application_workflow import APPLICATION_STATUSES
from psycopg2.extras import Json

developer_bp = Blueprint("developer", __name__, url_prefix="/api/developer")

@developer_bp.route("/stats", methods=["GET"])
@role_required("developer")
def get_stats():
    """Returns platform overview counters and distribution metrics for developers."""
    try:
        with get_db() as (conn, cur):
            cur.execute("""
                SELECT
                    (SELECT COUNT(*) FROM accounts) AS total_accounts,
                    (SELECT COUNT(*) FROM accounts WHERE role='user') AS candidates,
                    (SELECT COUNT(*) FROM accounts WHERE role='recruiter') AS recruiters,
                    (SELECT COUNT(*) FROM accounts WHERE role='developer') AS developers,
                    (SELECT COUNT(*) FROM companies) AS companies,
                    (SELECT COUNT(*) FROM companies WHERE status='pending') AS pending_companies,
                    (SELECT COUNT(*) FROM companies WHERE status='approved') AS approved_companies,
                    (SELECT COUNT(*) FROM companies WHERE status='rejected') AS rejected_companies,
                    (SELECT COUNT(*) FROM jobs) AS opportunities,
                    (SELECT COUNT(*) FROM jobs WHERE status='published' AND (deadline IS NULL OR deadline>=CURRENT_DATE)) AS active_opportunities,
                    (SELECT COUNT(*) FROM jobs WHERE status='draft') AS draft_opportunities,
                    (SELECT COUNT(*) FROM jobs WHERE status='closed') AS closed_opportunities,
                    (SELECT COUNT(*) FROM jobs WHERE status='published' AND deadline<CURRENT_DATE) AS expired_opportunities,
                    (SELECT COUNT(*) FROM applications) AS applications
            """)
            counts = dict(cur.fetchone())

            cur.execute(
                """
                SELECT current_status, COUNT(*) AS count
                FROM applications
                GROUP BY current_status;
                """
            )
            apps_by_status = clean_record(cur.fetchall())

            cur.execute("""
                SELECT c.id AS company_id, c.name, c.status, c.created_at,
                       COALESCE((SELECT rp.full_name FROM recruiter_profiles rp WHERE rp.company_id=c.id ORDER BY rp.created_at LIMIT 1),'') AS recruiter_name
                FROM companies c ORDER BY c.created_at DESC LIMIT 5
            """)
            recent_companies = clean_record(cur.fetchall())

            cur.execute("""
                SELECT j.id, j.title, j.status,
                       CASE WHEN j.status='published' AND j.deadline<CURRENT_DATE THEN 'expired' ELSE j.status END AS lifecycle_status,
                       j.created_at, COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                       j.owner_type, j.source_classification
                FROM jobs j LEFT JOIN companies c ON c.id=j.company_id
                ORDER BY j.created_at DESC LIMIT 5
            """)
            recent_opportunities = clean_record(cur.fetchall())

            cur.execute("""
                SELECT a.id AS application_id, a.current_status, a.applied_at,
                       cp.full_name AS candidate_name, j.title AS opportunity_title,
                       COALESCE(c.name,j.organization_name,'Platform curated') AS company_name
                FROM applications a
                JOIN candidate_profiles cp ON cp.id=a.candidate_id
                JOIN jobs j ON j.id=a.job_id
                LEFT JOIN companies c ON c.id=j.company_id
                ORDER BY a.applied_at DESC LIMIT 5
            """)
            recent_applications = clean_record(cur.fetchall())

            cur.execute("""
                SELECT event_type, target, detail, actor, happened_at
                FROM (
                    SELECT 'Company review'::text AS event_type, c.name AS target, c.status AS detail,
                           reviewer.username AS actor, c.reviewed_at AS happened_at
                    FROM companies c JOIN accounts reviewer ON reviewer.id=c.reviewed_by
                    WHERE c.reviewed_at IS NOT NULL
                    UNION ALL
                    SELECT 'Recruiter link review', acc.username || ' → ' || c.name, req.status,
                           reviewer.username, req.reviewed_at
                    FROM recruiter_company_link_requests req
                    JOIN accounts acc ON acc.id=req.account_id
                    JOIN companies c ON c.id=req.company_id
                    JOIN accounts reviewer ON reviewer.id=req.reviewed_by
                    WHERE req.reviewed_at IS NOT NULL
                ) activity
                ORDER BY happened_at DESC LIMIT 8
            """)
            recent_admin_actions = clean_record(cur.fetchall())

        return jsonify({
            "metrics": {
                **counts,
                "total_users": counts["candidates"],
                "total_recruiters": counts["recruiters"],
                "total_companies": counts["companies"],
                "total_jobs": counts["opportunities"],
                "active_jobs": counts["active_opportunities"],
                "total_applications": counts["applications"]
            },
            "applications_breakdown": apps_by_status,
            "recent_companies": recent_companies,
            "recent_opportunities": recent_opportunities,
            "recent_applications": recent_applications,
            "recent_admin_actions": recent_admin_actions
        }), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/companies/pending", methods=["GET"])
@role_required("developer")
def get_pending_companies():
    """Lists all companies pending developer review with recruiter profile info."""
    search = request.args.get("search", "").strip()
    try:
        with get_db() as (conn, cur):
            query = """
                SELECT 
                    c.id AS company_id,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    j.owner_type,
                    j.source_classification,
                    c.industry,
                    c.website,
                    c.location,
                    c.description,
                    c.status,
                    c.created_at,
                    rp.id AS recruiter_id,
                    rp.full_name AS recruiter_name,
                    rp.email AS recruiter_email,
                    rp.phone AS recruiter_phone,
                    rp.designation AS recruiter_designation,
                    acc.id AS account_id,
                    acc.username AS recruiter_username
                FROM companies c
                LEFT JOIN recruiter_profiles rp ON rp.company_id = c.id
                LEFT JOIN accounts acc ON acc.id = rp.account_id
                WHERE c.status = 'pending'
            """
            params = []
            if search:
                query += " AND (c.name ILIKE %s OR COALESCE(rp.full_name,'') ILIKE %s OR COALESCE(acc.username,'') ILIKE %s OR COALESCE(rp.email,'') ILIKE %s)"
                params.extend([f"%{search}%"] * 4)
            query += " ORDER BY c.created_at ASC"
            cur.execute(query, tuple(params))
            pending = clean_record(cur.fetchall())
        return jsonify({"pending_companies": pending}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/companies", methods=["GET"])
@role_required("developer")
def get_all_companies():
    """Lists all registered companies with their review details."""
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "").strip()
    if status_filter and status_filter not in {"pending", "approved", "rejected"}:
        return jsonify({"error": "Choose a valid company status filter."}), 400
    try:
        with get_db() as (conn, cur):
            query = """
                SELECT 
                    c.*,
                    (SELECT COUNT(*) FROM jobs j WHERE j.company_id=c.id) AS jobs_count,
                    reviewer.username AS reviewer_username,
                    COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT(
                        'recruiter_id',rp.id,'account_id',acc.id,'username',acc.username,
                        'full_name',rp.full_name,'email',rp.email,'designation',rp.designation
                    ) ORDER BY rp.created_at) FROM recruiter_profiles rp
                       JOIN accounts acc ON acc.id=rp.account_id WHERE rp.company_id=c.id),'[]'::json) AS recruiters
                FROM companies c
                LEFT JOIN accounts reviewer ON reviewer.id = c.reviewed_by
                WHERE 1=1
            """
            params = []
            if status_filter:
                query += " AND c.status=%s"
                params.append(status_filter)
            if search:
                query += " AND (c.name ILIKE %s OR COALESCE(c.industry,'') ILIKE %s OR COALESCE(c.location,'') ILIKE %s OR EXISTS (SELECT 1 FROM recruiter_profiles rp JOIN accounts acc ON acc.id=rp.account_id WHERE rp.company_id=c.id AND (rp.full_name ILIKE %s OR acc.username ILIKE %s OR COALESCE(rp.email,'') ILIKE %s)))"
                params.extend([f"%{search}%"] * 6)
            query += " ORDER BY c.created_at DESC"
            cur.execute(query, tuple(params))
            companies = clean_record(cur.fetchall())
        return jsonify({"companies": companies}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/companies/<int:company_id>/review", methods=["POST"])
@role_required("developer")
def review_company(company_id):
    """
    Approves or rejects a company registration.
    Records reviewer account ID and review timestamp.
    """
    developer_account_id = session["account_id"]
    data = request.get_json() or {}
    new_status = data.get("status")

    if new_status not in ("approved", "rejected"):
        return jsonify({"error": "Status must be 'approved' or 'rejected'."}), 400

    try:
        with get_db() as (conn, cur):
            cur.execute("SELECT status FROM companies WHERE id=%s FOR UPDATE", (company_id,))
            existing = cur.fetchone()
            if not existing:
                return jsonify({"error": "Company not found."}), 404
            if existing["status"] != "pending":
                return jsonify({"error": "Only pending companies can be reviewed."}), 409
            cur.execute(
                """
                UPDATE companies
                SET status = %s,
                    reviewed_by = %s,
                    reviewed_at = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING id, name, status, reviewed_at;
                """,
                (new_status, developer_account_id, company_id)
            )
            updated = clean_record(cur.fetchone())
            if not updated:
                return jsonify({"error": "Company not found."}), 404

        action_word = "approved" if new_status == "approved" else "rejected"
        return jsonify({
            "message": f"Company '{updated['name']}' has been {action_word}!",
            "company": updated
        }), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/companies/link-requests", methods=["GET"])
@role_required("developer")
def get_recruiter_link_requests():
    """Lists admin-mediated requests to join an existing company."""
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "pending").strip() or "pending"
    if status_filter and status_filter not in {"pending", "approved", "rejected", "all"}:
        return jsonify({"error": "Choose pending, approved, rejected, or all requests."}), 400
    try:
        with get_db() as (conn, cur):
            query = """
                SELECT req.id AS request_id, req.account_id, acc.username,
                       req.requested_full_name, req.requested_email, req.requested_phone,
                       req.requested_designation, req.status, req.created_at,
                       req.reviewed_at, req.review_notes,
                       c.id AS company_id, c.name AS company_name,
                       c.industry AS company_industry, c.website AS company_website,
                       c.location AS company_location, c.status AS company_status,
                       reviewer.username AS reviewed_by
                FROM recruiter_company_link_requests req
                JOIN accounts acc ON acc.id=req.account_id AND acc.role='recruiter'
                JOIN companies c ON c.id=req.company_id
                LEFT JOIN accounts reviewer ON reviewer.id=req.reviewed_by
                WHERE 1=1
            """
            params = []
            if status_filter != "all":
                query += " AND req.status=%s"
                params.append(status_filter)
            if search:
                query += " AND (acc.username ILIKE %s OR req.requested_full_name ILIKE %s OR COALESCE(req.requested_email,'') ILIKE %s OR c.name ILIKE %s)"
                params.extend([f"%{search}%"] * 4)
            query += " ORDER BY CASE WHEN req.status='pending' THEN 0 ELSE 1 END, req.created_at DESC"
            cur.execute(query, tuple(params))
            requests = clean_record(cur.fetchall())
        return jsonify({"requests": requests}), 200
    except Exception:
        current_app.logger.exception("Recruiter company link requests failed")
        return jsonify({"error": "Unable to load recruiter link requests."}), 500


@developer_bp.route("/companies/link-requests/<int:request_id>/review", methods=["POST"])
@role_required("developer")
def review_recruiter_link_request(request_id):
    """Approves or rejects an unlinked recruiter after administrator review."""
    data = request.get_json() or {}
    status = data.get("status")
    notes = data.get("notes") or ""
    if not isinstance(status, str) or status not in {"approved", "rejected"}:
        return jsonify({"error": "Status must be approved or rejected."}), 400
    if not isinstance(notes, str) or len(notes) > 3000:
        return jsonify({"error": "Review notes must be text with no more than 3,000 characters."}), 400
    notes = notes.strip()

    try:
        with get_db() as (conn, cur):
            cur.execute("""
                SELECT req.id, req.account_id, req.company_id, req.requested_full_name,
                       req.requested_email, req.requested_phone, req.requested_designation,
                       req.status AS request_status, c.name AS company_name, c.status AS company_status,
                       acc.role AS account_role
                FROM recruiter_company_link_requests req
                JOIN companies c ON c.id=req.company_id
                JOIN accounts acc ON acc.id=req.account_id
                WHERE req.id=%s
                FOR UPDATE OF req
            """, (request_id,))
            link_request = cur.fetchone()
            if not link_request:
                return jsonify({"error": "Recruiter link request not found."}), 404
            if link_request["request_status"] != "pending":
                return jsonify({"error": "This recruiter link request has already been reviewed."}), 409
            if link_request["account_role"] != "recruiter":
                return jsonify({"error": "The account is no longer a recruiter."}), 409

            if status == "approved":
                if link_request["company_status"] != "approved":
                    return jsonify({"error": "Approve the company before linking a recruiter to it."}), 409
                cur.execute("SELECT 1 FROM recruiter_profiles WHERE account_id=%s", (link_request["account_id"],))
                if cur.fetchone():
                    return jsonify({"error": "This recruiter is already linked to a company."}), 409
                cur.execute("""
                    INSERT INTO recruiter_profiles(account_id, company_id, full_name, email, phone, designation)
                    VALUES (%s,%s,%s,%s,%s,%s)
                    RETURNING id
                """, (link_request["account_id"], link_request["company_id"],
                      link_request["requested_full_name"], link_request["requested_email"],
                      link_request["requested_phone"], link_request["requested_designation"]))

            cur.execute("""
                UPDATE recruiter_company_link_requests
                SET status=%s, reviewed_by=%s, reviewed_at=CURRENT_TIMESTAMP, review_notes=%s
                WHERE id=%s
                RETURNING id, status, reviewed_at
            """, (status, session["account_id"], notes or None, request_id))
            reviewed = clean_record(cur.fetchone())
        action = "linked to" if status == "approved" else "not linked to"
        return jsonify({
            "message": f"Recruiter was {action} {link_request['company_name']}.",
            "request": reviewed
        }), 200
    except pg_errors.UniqueViolation:
        return jsonify({"error": "The recruiter is already linked or has another pending link request."}), 409
    except Exception:
        current_app.logger.exception("Recruiter company link review failed")
        return jsonify({"error": "Unable to review this recruiter link request."}), 500


@developer_bp.route("/users", methods=["GET"])
@role_required("developer")
def get_users_list():
    """Lists all candidate and recruiter accounts for platform administration."""
    search = request.args.get("search", "").strip()
    role_filter = request.args.get("role", "").strip()
    if role_filter and role_filter not in {"user", "recruiter", "developer"}:
        return jsonify({"error": "Choose a valid role filter."}), 400
    if len(search) > 120:
        return jsonify({"error": "Search text must be 120 characters or fewer."}), 400

    try:
        with get_db() as (conn, cur):
            query = """
                SELECT 
                    acc.id AS account_id,
                    acc.username,
                    acc.role,
                    acc.created_at,
                    COALESCE(cp.full_name, rp.full_name) AS full_name,
                    COALESCE(cp.email, rp.email) AS email,
                    c.name AS company_name,
                    c.status AS company_status
                FROM accounts acc
                LEFT JOIN candidate_profiles cp ON cp.account_id = acc.id
                LEFT JOIN recruiter_profiles rp ON rp.account_id = acc.id
                LEFT JOIN companies c ON c.id = rp.company_id
                WHERE 1=1
            """
            params = []
            if search:
                query += " AND (acc.username ILIKE %s OR COALESCE(cp.full_name,rp.full_name,'') ILIKE %s OR COALESCE(cp.email,rp.email,'') ILIKE %s)"
                params.extend([f"%{search}%"] * 3)

            if role_filter:
                query += " AND acc.role = %s"
                params.append(role_filter)

            query += " ORDER BY acc.created_at DESC;"
            cur.execute(query, tuple(params))
            users = clean_record(cur.fetchall())

        return jsonify({"users": users}), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/jobs", methods=["GET"])
@role_required("developer")
def get_all_jobs():
    """Lists searchable platform-wide opportunities without changing recruiter access."""
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "").strip()
    category_filter = request.args.get("category", "").strip()
    owner_filter = request.args.get("owner_type", "").strip().upper()
    source_filter = request.args.get("source_classification", "").strip()
    if owner_filter and owner_filter not in {"ADMIN", "RECRUITER"}:
        return jsonify({"error": "Choose a valid opportunity owner filter."}), 400
    if source_filter and source_filter not in {"ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM", "ADMIN_DEMO"}:
        return jsonify({"error": "Choose a valid source classification."}), 400
    if status_filter and status_filter not in {"published", "draft", "closed", "expired"}:
        return jsonify({"error": "Choose a valid opportunity status filter."}), 400
    try:
        with get_db() as (conn, cur):
            query = """
                SELECT 
                    j.*,
                    CASE WHEN j.status = 'published' AND j.deadline < CURRENT_DATE THEN 'expired' ELSE j.status END AS lifecycle_status,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    c.status AS company_status,
                    rp.full_name AS recruiter_name,
                    (SELECT COUNT(*) FROM applications a WHERE a.job_id=j.id) AS applicant_count,
                    COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('id',s.id,'name',s.name,'is_required',js.is_required,'min_proficiency',js.min_proficiency) ORDER BY s.name)
                              FROM job_skills js JOIN skills s ON s.id=js.skill_id WHERE js.job_id=j.id),'[]'::json) AS skills
                FROM jobs j
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN recruiter_profiles rp ON rp.id=j.recruiter_id
                WHERE 1=1
            """
            params = []
            if status_filter == "expired":
                query += " AND j.status='published' AND j.deadline<CURRENT_DATE"
            elif status_filter:
                query += " AND j.status=%s AND (j.status<>'published' OR j.deadline IS NULL OR j.deadline>=CURRENT_DATE)"
                params.append(status_filter)
            if category_filter:
                query += " AND j.opportunity_category=%s"
                params.append(category_filter)
            if owner_filter:
                query += " AND j.owner_type=%s"
                params.append(owner_filter)
            if source_filter:
                query += " AND j.source_classification=%s"
                params.append(source_filter)
            if search:
                query += " AND (j.title ILIKE %s OR COALESCE(c.name,j.organization_name,'') ILIKE %s OR COALESCE(rp.full_name,'') ILIKE %s OR COALESCE(j.source_url,'') ILIKE %s OR j.description ILIKE %s OR EXISTS (SELECT 1 FROM job_skills x JOIN skills sx ON sx.id=x.skill_id WHERE x.job_id=j.id AND sx.name ILIKE %s))"
                params.extend([f"%{search}%"] * 6)
            query += " ORDER BY j.created_at DESC"
            cur.execute(query, tuple(params))
            jobs = clean_record(cur.fetchall())
        return jsonify({"jobs": jobs}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@developer_bp.route("/jobs/<int:job_id>", methods=["GET"])
@role_required("developer")
def get_job_details(job_id):
    """Returns opportunity details for read-only platform oversight."""
    try:
        with get_db() as (conn, cur):
            cur.execute("""
                SELECT j.*,
                       CASE WHEN j.status='published' AND j.deadline<CURRENT_DATE THEN 'expired' ELSE j.status END AS lifecycle_status,
                       COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,c.status AS company_status,c.website AS company_website,
                       rp.full_name AS recruiter_name,
                       (SELECT COUNT(*) FROM applications a WHERE a.job_id=j.id) AS applicant_count,
                       COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('id',s.id,'name',s.name,'is_required',js.is_required,'min_proficiency',js.min_proficiency) ORDER BY s.name)
                                 FROM job_skills js JOIN skills s ON s.id=js.skill_id WHERE js.job_id=j.id),'[]'::json) AS skills
                FROM jobs j LEFT JOIN companies c ON c.id=j.company_id
                LEFT JOIN recruiter_profiles rp ON rp.id=j.recruiter_id
                WHERE j.id=%s
            """, (job_id,))
            job = clean_record(cur.fetchone())
        if not job:
            return jsonify({"error": "Opportunity not found."}), 404
        return jsonify({"job": job}), 200
    except Exception:
        current_app.logger.exception("Opportunity detail audit failed")
        return jsonify({"error": "Unable to load opportunity details."}), 500




ADMIN_OPPORTUNITY_TYPES = {"employment", "internship", "hackathon", "competition", "scholarship", "research", "fellowship", "government", "psu", "gate", "workshop", "training", "program", "other"}
ADMIN_CATEGORIES = {"job", "internship", "hackathon", "project", "open_source", "research", "scholarship", "fellowship", "competition", "workshop", "developer_program", "startup", "apprenticeship", "certification", "government", "psu", "gate", "training"}
ADMIN_JOB_TYPES = {"Full-time", "Part-time", "Internship", "Contract"}
ADMIN_WORK_MODES = {"Remote", "Hybrid", "On-site"}
ADMIN_LEVELS = {"Beginner", "Intermediate", "Advanced", "Student", "Fresher"}
ADMIN_PAID_STATUSES = {"paid", "unpaid", "stipend", "prize", "none"}
ADMIN_PROFICIENCIES = {"Beginner", "Intermediate", "Advanced", "Expert"}


def _admin_text(data, key, label, maximum, required=False):
    value = data.get(key)
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{label} is required.")
    if len(value) > maximum:
        raise ValueError(f"{label} must be {maximum} characters or fewer.")
    return value or None


def _admin_url(value, label, required=False):
    if value is None:
        if required:
            raise ValueError(f"{label} is required.")
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a valid HTTP or HTTPS URL.")
    value = value.strip()
    if not value:
        if required:
            raise ValueError(f"{label} is required.")
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise ValueError(f"{label} must be a valid HTTP or HTTPS URL.")
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or len(value) > 500:
        raise ValueError(f"{label} must be a valid HTTP or HTTPS URL no longer than 500 characters.")
    return value


def _admin_money(value, label):
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a valid non-negative amount.")
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError(f"{label} must be a valid non-negative amount.")
    if not amount.is_finite() or amount < 0 or amount > Decimal("9999999999.99"):
        raise ValueError(f"{label} must be a valid non-negative amount.")
    return amount.quantize(Decimal("0.01"))


def _admin_opportunity_values(data):
    title = _admin_text(data, "title", "Title", 200, True)
    organization_name = _admin_text(data, "organization_name", "Organization name", 200)
    opportunity_type = data.get("opportunity_type")
    if opportunity_type not in ADMIN_OPPORTUNITY_TYPES:
        raise ValueError("Choose a valid opportunity type.")
    job_type = data.get("job_type")
    if opportunity_type == "employment":
        if job_type not in {"Full-time", "Part-time", "Contract"}:
            raise ValueError("Choose a valid employment type.")
    elif opportunity_type == "internship":
        job_type = "Internship"
    else:
        job_type = None
    category = data.get("opportunity_category")
    if category not in ADMIN_CATEGORIES:
        raise ValueError("Choose a valid opportunity category.")
    work_mode = data.get("work_mode") or None
    if work_mode is not None and work_mode not in ADMIN_WORK_MODES:
        raise ValueError("Choose a valid work mode.")
    location = _admin_text(data, "location", "Location", 150, True)
    description = _admin_text(data, "description", "Description", 50000, True)
    requirements = _admin_text(data, "requirements", "Requirements", 50000)
    eligibility = _admin_text(data, "eligibility", "Eligibility", 10000)
    experience_level = data.get("experience_level", "Student")
    if experience_level not in ADMIN_LEVELS:
        raise ValueError("Choose a valid experience level.")
    paid_status = data.get("paid_status", "none")
    if paid_status not in ADMIN_PAID_STATUSES:
        raise ValueError("Choose a valid compensation type.")
    source_classification = data.get("source_classification")
    if source_classification not in {"ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM", "ADMIN_DEMO"}:
        raise ValueError("Choose a valid source classification.")
    source_url = _admin_url(data.get("source_url"), "Official source URL", source_classification != "ADMIN_DEMO")
    application_mode = data.get("application_mode", "internal")
    if application_mode not in {"internal", "external"}:
        raise ValueError("Application mode must be internal or external.")
    application_url = _admin_url(data.get("application_url"), "Application or registration URL", application_mode == "external")
    raw_deadline = data.get("deadline")
    try:
        deadline = date.fromisoformat(str(raw_deadline)) if raw_deadline else None
    except (TypeError, ValueError):
        raise ValueError("Provide a valid deadline in YYYY-MM-DD format.")
    if deadline is None and not (
        source_classification in {"ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM"}
        and application_mode == "external" and source_url and application_url
    ):
        raise ValueError("A deadline is required unless this is an official external listing with no published deadline.")
    if work_mode is None and not (
        source_classification in {"ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM"}
        and application_mode == "external" and source_url and application_url
    ):
        raise ValueError("Choose a work mode unless the official external source does not specify one.")
    status = data.get("status", "draft")
    if status not in {"draft", "published", "closed"}:
        raise ValueError("Choose draft, published, or closed status.")
    if source_classification == "ADMIN_DEMO" and status == "published":
        raise ValueError("Demo opportunities must remain unpublished.")
    salary_min = _admin_money(data.get("salary_min"), "Minimum compensation")
    salary_max = _admin_money(data.get("salary_max"), "Maximum compensation")
    if salary_max < salary_min:
        raise ValueError("Maximum compensation must be greater than or equal to minimum compensation.")
    positions = data.get("positions")
    if positions not in (None, ""):
        if isinstance(positions, bool):
            raise ValueError("Positions must be a positive whole number.")
        try:
            normalized_positions = int(positions)
        except (TypeError, ValueError):
            raise ValueError("Positions must be a positive whole number.")
        if normalized_positions < 1 or str(positions).strip() != str(normalized_positions):
            raise ValueError("Positions must be a positive whole number.")
        positions = normalized_positions
    else:
        positions = None
    branches = data.get("eligible_branches") or []
    if not isinstance(branches, list) or any(not isinstance(item, str) for item in branches):
        raise ValueError("Eligible branches must be a list of branch names.")
    branches = list(dict.fromkeys(item.strip() for item in branches if item.strip()))
    if len(branches) > 50 or any(len(item) > 100 for item in branches):
        raise ValueError("Provide no more than 50 branch names, each 100 characters or fewer.")
    skills = data.get("skill_ids") or []
    if not isinstance(skills, list) or len(skills) > 100:
        raise ValueError("Skills must be a list of at most 100 entries.")
    normalized_skills = []
    seen = set()
    for item in skills:
        if not isinstance(item, dict):
            raise ValueError("Each skill must include an ID, required flag, and proficiency.")
        skill_id = item.get("skill_id")
        if isinstance(skill_id, bool) or not isinstance(skill_id, int) or skill_id < 1 or skill_id in seen:
            raise ValueError("Skill IDs must be valid and unique.")
        seen.add(skill_id)
        required = item.get("is_required", True)
        proficiency = item.get("min_proficiency", "Intermediate")
        if not isinstance(required, bool) or proficiency not in ADMIN_PROFICIENCIES:
            raise ValueError("Choose valid skill requirement and proficiency values.")
        normalized_skills.append((skill_id, required, proficiency))
    event_details = data.get("hackathon_details") or {}
    if category == "hackathon" or opportunity_type == "hackathon":
        if not isinstance(event_details, dict):
            raise ValueError("Hackathon details must be an object.")
        allowed_text = {
            "organizer_type": 60, "event_mode": 20, "city": 100, "state": 100, "country": 100,
            "venue": 200, "themes": 1000, "tracks": 2000, "technologies": 1000,
            "team_size_min": 4, "team_size_max": 4, "prize_pool": 100,
            "prize_details": 2000, "banner_url": 500, "organizer_logo_url": 500,
            "official_website_url": 500, "organizer_website_url": 500,
            "registration_open_date": 10, "event_start_date": 10, "event_end_date": 10,
        }
        cleaned = {}
        for key, maximum in allowed_text.items():
            value = event_details.get(key)
            if value in (None, ""):
                continue
            if not isinstance(value, str) or len(value.strip()) > maximum:
                raise ValueError(f"Hackathon field {key} is invalid or too long.")
            value = value.strip()
            if key.endswith("_url"):
                value = _admin_url(value, key.replace("_", " "))
            if key.endswith("_date"):
                try:
                    date.fromisoformat(value)
                except ValueError:
                    raise ValueError(f"{key.replace('_', ' ').title()} must use YYYY-MM-DD.")
            cleaned[key] = value
        if cleaned.get("event_mode") and cleaned["event_mode"] not in {"Online", "Offline", "Hybrid"}:
            raise ValueError("Event mode must be Online, Offline, or Hybrid.")
        for key in ("individual_allowed", "certificates"):
            value = event_details.get(key)
            if value is not None:
                if not isinstance(value, bool):
                    raise ValueError(f"{key.replace('_', ' ').title()} must be true or false.")
                cleaned[key] = value
        for key in ("team_size_min", "team_size_max"):
            if key in cleaned:
                try:
                    number = int(cleaned[key])
                except ValueError:
                    raise ValueError("Team sizes must be positive whole numbers.")
                if number < 1 or number > 100:
                    raise ValueError("Team sizes must be between 1 and 100.")
                cleaned[key] = number
        if cleaned.get("team_size_min") and cleaned.get("team_size_max") and cleaned["team_size_min"] > cleaned["team_size_max"]:
            raise ValueError("Minimum team size cannot exceed maximum team size.")
        if cleaned.get("event_start_date") and cleaned.get("event_end_date") and cleaned["event_start_date"] > cleaned["event_end_date"]:
            raise ValueError("Event end date must be on or after its start date.")
        event_details = cleaned
    else:
        event_details = {}
    return {
        "title": title, "organization_name": organization_name, "opportunity_type": opportunity_type,
        "job_type": job_type, "opportunity_category": category, "work_mode": work_mode,
        "location": location, "description": description, "requirements": requirements,
        "eligibility": eligibility, "experience_level": experience_level, "paid_status": paid_status,
        "source_classification": source_classification, "source_url": source_url,
        "application_mode": application_mode, "application_url": application_url,
        "deadline": deadline, "status": status, "salary_min": salary_min, "salary_max": salary_max,
        "positions": positions, "eligible_branches": branches, "skills": normalized_skills,
        "is_verified": source_classification == "ADMIN_CURATED_VERIFIED",
        "is_source_reviewed": source_classification in {"ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM"},
        "is_sample": source_classification == "ADMIN_DEMO",
        "hackathon_details": event_details,
    }


def _validate_admin_skills(cur, values):
    skill_ids = [entry[0] for entry in values["skills"]]
    if not skill_ids:
        return
    cur.execute("SELECT id FROM skills WHERE id = ANY(%s)", (skill_ids,))
    found = {row["id"] for row in cur.fetchall()}
    if found != set(skill_ids):
        raise ValueError("One or more selected skills are unavailable. Refresh the skills catalog.")


@developer_bp.route("/jobs", methods=["POST"])
@role_required("developer")
def create_curated_opportunity():
    data = request.get_json() or {}
    try:
        values = _admin_opportunity_values(data)
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        with get_db() as (conn, cur):
            _validate_admin_skills(cur, values)
            if values["status"] == "published" and values["deadline"] and is_deadline_expired(cur, values["deadline"].isoformat()):
                return jsonify({"error": "Choose today or a future deadline before publishing."}), 400
            cur.execute("""
                INSERT INTO jobs (
                    company_id,recruiter_id,owner_type,created_by_admin,organization_name,
                    title,job_type,opportunity_type,work_mode,location,description,requirements,
                    salary_min,salary_max,deadline,status,opportunity_category,experience_level,
                    paid_status,eligibility,application_url,application_mode,positions,
                    source,source_classification,source_url,source_verified_by,source_verified_at,
                    is_verified,is_sample,eligible_branches,hackathon_details
                ) VALUES (
                    NULL,NULL,'ADMIN',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    'admin_curated',%s,%s,CASE WHEN %s THEN %s ELSE NULL END,
                    CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END,%s,%s,%s,%s::jsonb
                ) RETURNING id
            """, (
                session["account_id"],values["organization_name"],values["title"],values["job_type"],values["opportunity_type"],
                values["work_mode"],values["location"],values["description"],values["requirements"],values["salary_min"],
                values["salary_max"],values["deadline"],values["status"],values["opportunity_category"],values["experience_level"],
                values["paid_status"],values["eligibility"],values["application_url"],values["application_mode"],values["positions"],
                values["source_classification"],values["source_url"],values["is_source_reviewed"],session["account_id"],
                values["is_source_reviewed"],values["is_verified"],values["is_sample"],values["eligible_branches"],Json(values["hackathon_details"]),
            ))
            job_id=cur.fetchone()["id"]
            for skill_id, required, proficiency in values["skills"]:
                cur.execute("INSERT INTO job_skills(job_id,skill_id,is_required,min_proficiency) VALUES(%s,%s,%s,%s)",(job_id,skill_id,required,proficiency))
        return jsonify({"message":"Curated opportunity created.","job_id":job_id}),201
    except ValueError as exc:
        return jsonify({"error":str(exc)}),400
    except pg_errors.ForeignKeyViolation:
        return jsonify({"error":"The selected creator or skills are no longer available."}),400
    except Exception:
        current_app.logger.exception("Curated opportunity creation failed")
        return jsonify({"error":"Unable to create this opportunity."}),500


@developer_bp.route("/jobs/<int:job_id>", methods=["PUT"])
@role_required("developer")
def update_curated_opportunity(job_id):
    data = request.get_json() or {}
    try:
        values = _admin_opportunity_values(data)
    except (ValueError, TypeError) as exc:
        return jsonify({"error":str(exc)}),400
    try:
        with get_db() as (conn,cur):
            cur.execute("SELECT status FROM jobs WHERE id=%s AND owner_type='ADMIN' FOR UPDATE",(job_id,))
            existing=cur.fetchone()
            if not existing:
                return jsonify({"error":"Admin-curated opportunity not found."}),404
            _validate_admin_skills(cur,values)
            if values["status"] == "published" and values["deadline"] and is_deadline_expired(cur,values["deadline"].isoformat()):
                return jsonify({"error":"Choose today or a future deadline before publishing."}),400
            cur.execute("""
                UPDATE jobs SET organization_name=%s,title=%s,job_type=%s,opportunity_type=%s,
                    work_mode=%s,location=%s,description=%s,requirements=%s,salary_min=%s,salary_max=%s,
                    deadline=%s,status=%s,opportunity_category=%s,experience_level=%s,paid_status=%s,
                    eligibility=%s,application_url=%s,application_mode=%s,positions=%s,
                    source_classification=%s,source_url=%s,
                    source_verified_by=CASE WHEN %s THEN %s ELSE NULL END,
                    source_verified_at=CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END,
                    is_verified=%s,is_sample=%s,eligible_branches=%s,hackathon_details=%s::jsonb,updated_at=CURRENT_TIMESTAMP
                WHERE id=%s AND owner_type='ADMIN' RETURNING id
            """,(
                values["organization_name"],values["title"],values["job_type"],values["opportunity_type"],values["work_mode"],
                values["location"],values["description"],values["requirements"],values["salary_min"],values["salary_max"],
                values["deadline"],values["status"],values["opportunity_category"],values["experience_level"],values["paid_status"],
                values["eligibility"],values["application_url"],values["application_mode"],values["positions"],
                values["source_classification"],values["source_url"],values["is_source_reviewed"],session["account_id"],
                values["is_source_reviewed"],values["is_verified"],values["is_sample"],values["eligible_branches"],Json(values["hackathon_details"]),job_id,
            ))
            cur.execute("DELETE FROM job_skills WHERE job_id=%s",(job_id,))
            for skill_id,required,proficiency in values["skills"]:
                cur.execute("INSERT INTO job_skills(job_id,skill_id,is_required,min_proficiency) VALUES(%s,%s,%s,%s)",(job_id,skill_id,required,proficiency))
        return jsonify({"message":"Curated opportunity updated.","job_id":job_id}),200
    except ValueError as exc:
        return jsonify({"error":str(exc)}),400
    except pg_errors.ForeignKeyViolation:
        return jsonify({"error":"The selected skills are no longer available."}),400
    except Exception:
        current_app.logger.exception("Curated opportunity update failed")
        return jsonify({"error":"Unable to update this opportunity."}),500


@developer_bp.route("/jobs/<int:job_id>/status", methods=["PATCH"])
@role_required("developer")
def set_curated_opportunity_status(job_id):
    data=request.get_json() or {}
    status=data.get("status")
    if status not in {"draft","published","closed"}:
        return jsonify({"error":"Status must be draft, published, or closed."}),400
    try:
        with get_db() as (conn,cur):
            cur.execute("SELECT deadline,source_classification FROM jobs WHERE id=%s AND owner_type='ADMIN' FOR UPDATE",(job_id,))
            existing=cur.fetchone()
            if not existing:
                return jsonify({"error":"Admin-curated opportunity not found."}),404
            if existing["source_classification"]=="ADMIN_DEMO" and status=="published":
                return jsonify({"error":"Demo opportunities must remain unpublished."}),400
            if status=="published" and is_deadline_expired(cur,existing["deadline"]):
                return jsonify({"error":"Set a valid current or future deadline before publishing."}),400
            cur.execute("UPDATE jobs SET status=%s,updated_at=CURRENT_TIMESTAMP WHERE id=%s AND owner_type='ADMIN' RETURNING id,status",(status,job_id))
            updated=cur.fetchone()
        return jsonify({"message":f"Opportunity status set to {status}.","job":clean_record(updated)}),200
    except Exception:
        current_app.logger.exception("Curated opportunity status update failed")
        return jsonify({"error":"Unable to change this opportunity's status."}),500


@developer_bp.route("/jobs/<int:job_id>", methods=["DELETE"])
@role_required("developer")
def archive_curated_opportunity(job_id):
    """Soft archive curated records so saved/application relationships remain intact."""
    try:
        with get_db() as (conn,cur):
            cur.execute("UPDATE jobs SET is_archived=TRUE,status='closed',updated_at=CURRENT_TIMESTAMP WHERE id=%s AND owner_type='ADMIN' AND is_archived=FALSE RETURNING id",(job_id,))
            row=cur.fetchone()
        if not row:
            return jsonify({"error":"Admin-curated opportunity not found."}),404
        return jsonify({"message":"Opportunity archived. Existing applications and bookmarks were preserved."}),200
    except Exception:
        current_app.logger.exception("Curated opportunity archive failed")
        return jsonify({"error":"Unable to archive this opportunity."}),500


@developer_bp.route("/applications", methods=["GET"])
@role_required("developer")
def get_all_applications():
    """Audit view of all applications submitted across the platform."""
    search = request.args.get("search", "").strip()
    status_filter = request.args.get("status", "").strip()
    valid_statuses = set(APPLICATION_STATUSES)
    if status_filter and status_filter not in valid_statuses:
        return jsonify({"error": "Choose a valid application status filter."}), 400
    try:
        with get_db() as (conn, cur):
            query = """
                SELECT 
                    a.id AS application_id,
                    a.current_status,
                    a.applied_at,
                    a.updated_at,
                    cp.id AS candidate_id,
                    cp.full_name AS candidate_name,
                    cp.email AS candidate_email,
                    j.id AS job_id,
                    j.title AS job_title,
                    c.id AS company_id,
                    c.name AS company_name,
                    rp.full_name AS recruiter_name,
                    COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT(
                        'previous_status',h.previous_status,'status',h.status,'notes',h.notes,'changed_at',h.changed_at,'changed_by',actor.username
                    ) ORDER BY h.changed_at,h.id) FROM application_status_history h
                       LEFT JOIN accounts actor ON actor.id=h.changed_by WHERE h.application_id=a.id),'[]'::json) AS status_history
                FROM applications a
                JOIN candidate_profiles cp ON cp.id = a.candidate_id
                JOIN jobs j ON j.id = a.job_id
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN recruiter_profiles rp ON rp.id=j.recruiter_id
                WHERE 1=1
            """
            params = []
            if status_filter:
                query += " AND a.current_status=%s"
                params.append(status_filter)
            if search:
                query += " AND (cp.full_name ILIKE %s OR COALESCE(cp.email,'') ILIKE %s OR j.title ILIKE %s OR COALESCE(c.name,j.organization_name,'') ILIKE %s OR COALESCE(rp.full_name,'') ILIKE %s)"
                params.extend([f"%{search}%"] * 5)
            query += " ORDER BY a.applied_at DESC"
            cur.execute(query, tuple(params))
            apps = clean_record(cur.fetchall())
        return jsonify({"applications": apps}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500
