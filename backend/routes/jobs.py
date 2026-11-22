from backend.fastapi_compat import Blueprint, request, jsonify, session, current_app
from backend.db import get_db
from backend.utils import role_required, clean_record
from backend.opportunity_lifecycle import active_deadline_predicate, is_deadline_expired
from backend.branch_matching import get_candidate_branch, classify_branch_eligibility, is_unrestricted, sql_branch_filter
from backend.skill_matching import analyze_skill_gap
from backend.notification_service import create_notification
from psycopg2 import errors as pg_errors
from datetime import date

jobs_bp = Blueprint("jobs", __name__, url_prefix="/api/jobs")


@jobs_bp.route("/hackathons", methods=["GET"])
def list_hackathons():
    """Source-linked published hackathons from the shared opportunities table."""
    search = request.args.get("search", "").strip()[:150]
    location = request.args.get("location", "").strip()[:120]
    mode = request.args.get("mode", "").strip()
    theme = request.args.get("theme", "").strip()[:100]
    status_filter = request.args.get("status", "").strip()
    participation = request.args.get("participation", "").strip()
    sort = request.args.get("sort", "upcoming").strip()
    page = max(1, request.args.get("page", 1, type=int))
    limit = min(30, max(1, request.args.get("limit", 12, type=int)))
    if mode and mode not in {"Online", "Offline", "Hybrid"}:
        return jsonify({"error": "Choose Online, Offline, or Hybrid mode."}), 400
    if status_filter and status_filter not in {"upcoming", "ongoing", "completed", "registration_open", "registration_closed", "closing_soon"}:
        return jsonify({"error": "Choose a valid hackathon status."}), 400
    if participation and participation not in {"individual", "team"}:
        return jsonify({"error": "Choose individual or team participation."}), 400
    order = {
        "upcoming": "COALESCE((j.hackathon_details->>'event_start_date')::date,j.start_date,CURRENT_DATE) ASC,j.created_at DESC",
        "recent": "j.created_at DESC",
        "deadline": "j.deadline ASC NULLS LAST,j.created_at DESC",
    }.get(sort)
    if not order:
        return jsonify({"error": "Choose upcoming, recent, or deadline sorting."}), 400
    try:
        with get_db() as (conn, cur):
            filters = ["j.opportunity_category='hackathon'", "j.status='published'", "j.is_archived=FALSE", "(j.owner_type='ADMIN' OR c.status='approved')", "(COALESCE((j.hackathon_details->>'event_end_date')::date,j.start_date,CURRENT_DATE)>=CURRENT_DATE OR COALESCE((j.hackathon_details->>'event_start_date')::date,j.start_date,CURRENT_DATE)>=CURRENT_DATE OR j.deadline>=CURRENT_DATE)"]
            params = []
            if search:
                filters.append("(j.title ILIKE %s OR COALESCE(j.organization_name,c.name,'') ILIKE %s OR COALESCE(j.hackathon_details->>'themes','') ILIKE %s OR COALESCE(j.hackathon_details->>'technologies','') ILIKE %s OR COALESCE(j.hackathon_details->>'tracks','') ILIKE %s)")
                like = f"%{search}%"; params.extend([like] * 5)
            if location:
                filters.append("(j.location ILIKE %s OR COALESCE(j.hackathon_details->>'city','') ILIKE %s OR COALESCE(j.hackathon_details->>'state','') ILIKE %s)")
                like = f"%{location}%"; params.extend([like] * 3)
            if mode:
                filters.append("(CASE COALESCE(j.hackathon_details->>'event_mode','') WHEN 'Online' THEN 'Online' WHEN 'Offline' THEN 'Offline' WHEN 'Hybrid' THEN 'Hybrid' WHEN '' THEN CASE j.work_mode WHEN 'Remote' THEN 'Online' WHEN 'On-site' THEN 'Offline' ELSE j.work_mode END ELSE j.hackathon_details->>'event_mode' END)=%s")
                params.append(mode)
            if theme:
                filters.append("(COALESCE(j.hackathon_details->>'themes','') ILIKE %s OR COALESCE(j.hackathon_details->>'tracks','') ILIKE %s OR COALESCE(j.hackathon_details->>'technologies','') ILIKE %s)")
                like = f"%{theme}%"; params.extend([like] * 3)
            if participation == "individual": filters.append("COALESCE((j.hackathon_details->>'individual_allowed')::boolean,FALSE)=TRUE")
            if participation == "team": filters.append("(j.hackathon_details ? 'team_size_min' OR j.hackathon_details ? 'team_size_max')")
            if status_filter in {"registration_open", "closing_soon"}: filters.append("(j.deadline IS NULL OR j.deadline>=CURRENT_DATE)")
            if status_filter == "closing_soon": filters.append("j.deadline<=CURRENT_DATE+7")
            if status_filter == "registration_closed": filters.append("j.deadline<CURRENT_DATE")
            if status_filter == "upcoming": filters.append("COALESCE((j.hackathon_details->>'event_start_date')::date,j.start_date,CURRENT_DATE)>=CURRENT_DATE")
            if status_filter == "ongoing": filters.append("COALESCE((j.hackathon_details->>'event_start_date')::date,j.start_date)<=CURRENT_DATE AND COALESCE((j.hackathon_details->>'event_end_date')::date,j.start_date)>=CURRENT_DATE")
            if status_filter == "completed": filters.append("COALESCE((j.hackathon_details->>'event_end_date')::date,j.start_date)<CURRENT_DATE")
            where = " AND ".join(filters)
            cur.execute(f"SELECT COUNT(*) AS total FROM jobs j LEFT JOIN companies c ON c.id=j.company_id WHERE {where}", params)
            total = cur.fetchone()["total"]
            cur.execute(f"""SELECT j.id,j.title,j.organization_name,COALESCE(c.name,j.organization_name,'Organizer') AS organizer_name,
                j.location,j.work_mode,j.description,j.deadline,j.start_date,j.application_url,j.source_url,j.source_verified_at,
                j.is_verified,j.status,j.created_at,j.hackathon_details,j.is_archived,j.opportunity_category
                FROM jobs j LEFT JOIN companies c ON c.id=j.company_id WHERE {where}
                ORDER BY {order} LIMIT %s OFFSET %s""", params + [limit,page and (page-1)*limit])
            events = clean_record(cur.fetchall())
            cur.execute("""SELECT COUNT(*) FILTER(WHERE deadline IS NULL OR deadline>=CURRENT_DATE) AS open,
                COUNT(*) FILTER(WHERE COALESCE(hackathon_details->>'event_mode',CASE work_mode WHEN 'Remote' THEN 'Online' WHEN 'On-site' THEN 'Offline' ELSE work_mode END)='Online') AS online,
                COUNT(*) FILTER(WHERE COALESCE(hackathon_details->>'event_mode',CASE work_mode WHEN 'Remote' THEN 'Online' WHEN 'On-site' THEN 'Offline' ELSE work_mode END)='Offline') AS offline
                FROM jobs WHERE opportunity_category='hackathon' AND status='published' AND is_archived=FALSE""")
            summary = clean_record(cur.fetchone())
        return jsonify({"hackathons":events,"summary":summary,"page":page,"limit":limit,"total":total,"has_more":page*limit<total}),200
    except Exception:
        current_app.logger.exception("Hackathon discovery failed")
        return jsonify({"error":"Unable to load hackathons right now."}),500

@jobs_bp.route("", methods=["GET"])
def list_jobs():
    """
    Public and Candidate job browsing endpoint.
    Filters: search query, job type, work mode, and location.
    Only returns published jobs whose deadline is >= CURRENT_DATE.
    """
    search = request.args.get("search", "").strip()
    page = max(1, request.args.get("page", 1, type=int))
    limit = min(50, max(1, request.args.get("limit", 12, type=int)))
    category, job_type = request.args.get("category", "").strip(), request.args.get("job_type", "").strip()
    work_mode, location = request.args.get("work_mode", "").strip(), request.args.get("location", "").strip()
    paid_status, level = request.args.get("paid_status", "").strip(), request.args.get("experience_level", "").strip()
    minimum_match = request.args.get("min_match", 0, type=int)
    eligibility = request.args.get("eligibility", "my" if session.get("role") == "user" else "all").strip().lower()
    branch_filter = request.args.get("branch", "").strip()
    skill_filter = request.args.get("skill", "").strip()
    source_filter = request.args.get("source", "").strip().upper()
    deadline_before = request.args.get("deadline_before", "").strip()
    if eligibility not in {"my", "all"}:
        return jsonify({"error": "Eligibility must be 'my' or 'all'."}), 400
    if branch_filter and len(branch_filter) > 150:
        return jsonify({"error": "Branch filter is too long."}), 400
    if skill_filter and len(skill_filter) > 100:
        return jsonify({"error": "Skill filter is too long."}), 400
    if source_filter and source_filter not in {"ADMIN", "RECRUITER", "ADMIN_CURATED_VERIFIED", "ADMIN_CURATED_PROGRAM", "ADMIN_DEMO"}:
        return jsonify({"error": "Choose a valid opportunity source."}), 400
    if deadline_before:
        try:
            date.fromisoformat(deadline_before)
        except ValueError:
            return jsonify({"error": "Deadline filter must use YYYY-MM-DD."}), 400
    sort = request.args.get("sort", "recent")
    order_sql = {"recent": "j.created_at DESC", "deadline": "j.deadline ASC NULLS LAST", "compensation": "j.salary_max DESC"}.get(sort, "match_percentage DESC NULLS LAST, j.created_at DESC")

    try:
        with get_db() as (conn, cur):
            candidate_id = None
            candidate_branch = None
            candidate_skills = []
            if session.get("role") == "user":
                cur.execute("SELECT id FROM candidate_profiles WHERE account_id=%s", (session.get("account_id"),))
                candidate = cur.fetchone()
                candidate_id = candidate["id"] if candidate else None
                candidate_branch = get_candidate_branch(cur, candidate_id) if candidate_id else None
                if candidate_id:
                    cur.execute("SELECT s.name FROM candidate_skills cs JOIN skills s ON s.id=cs.skill_id WHERE cs.candidate_id=%s", (candidate_id,))
                    candidate_skills = [row["name"] for row in cur.fetchall()]
            elif eligibility == "my":
                return jsonify({"error": "Sign in as a candidate to filter by your branch."}), 403
            query = f"""
                WITH candidate_skills AS (
                  SELECT cs.skill_id, cs.proficiency, cs.years_of_experience
                  FROM candidate_skills cs WHERE cs.candidate_id = %s
                ), score AS (
                  SELECT js.job_id,
                    COALESCE(SUM(CASE WHEN js.is_required THEN 4 ELSE 1 END),0) AS total_weight,
                    COALESCE(SUM(CASE WHEN csk.skill_id IS NOT NULL AND
                      CASE csk.proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 0 END >=
                      CASE js.min_proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 2 END
                      THEN CASE WHEN js.is_required THEN 4 ELSE 1 END ELSE 0 END),0) AS matched_weight,
                    COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT('name',s.name,'matched',csk.skill_id IS NOT NULL AND
                      CASE csk.proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 0 END >=
                      CASE js.min_proficiency WHEN 'Beginner' THEN 1 WHEN 'Intermediate' THEN 2 WHEN 'Advanced' THEN 3 WHEN 'Expert' THEN 4 ELSE 2 END,'required',js.is_required)) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS skill_breakdown
                  FROM job_skills js JOIN skills s ON s.id=js.skill_id
                  LEFT JOIN candidate_skills csk ON csk.skill_id=js.skill_id
                  GROUP BY js.job_id
                )
                SELECT 
                    j.id,
                    j.title,
                    j.job_type,
                    j.work_mode,
                    j.location,
                    j.description,
                    j.requirements,
                    j.salary_min,
                    j.salary_max,
                    j.deadline,
                    CASE WHEN j.deadline IS NULL THEN NULL ELSE GREATEST(j.deadline - CURRENT_DATE,0) END AS days_remaining,
                    j.created_at,
                    c.id AS company_id,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    c.industry,
                    c.website,
                    COALESCE(c.location,j.location) AS company_location,
                    j.opportunity_category, j.opportunity_type, j.experience_level, j.paid_status, j.eligibility,
                    j.start_date, j.duration, j.application_url, j.application_mode, j.positions, j.source,
                    j.owner_type,j.organization_name,j.eligible_branches,j.source_classification,j.source_url,j.source_verified_at,
                    j.is_sample, j.is_verified,
                    CASE WHEN %s IS NULL OR COALESCE(score.total_weight,0)=0 THEN NULL ELSE ROUND(100.0*score.matched_weight/score.total_weight,1) END AS match_percentage,
                    COALESCE(score.skill_breakdown,'[]'::jsonb) AS skill_breakdown,
                    COALESCE(
                        JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id', s.id, 
                                'name', s.name, 
                                'is_required', js.is_required, 
                                'min_proficiency', js.min_proficiency
                            )
                        ) FILTER (WHERE s.id IS NOT NULL), '[]'::json
                    ) AS required_skills
                FROM jobs j
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN job_skills js ON js.job_id = j.id
                LEFT JOIN skills s ON s.id = js.skill_id
                LEFT JOIN score ON score.job_id=j.id
                WHERE j.status = 'published' AND {active_deadline_predicate('j')} AND j.is_archived=FALSE AND (j.owner_type='ADMIN' OR c.status='approved')
            """
            params = [candidate_id, candidate_id]

            if eligibility == "my" and candidate_branch:
                branch_clause, branch_params = sql_branch_filter("j", candidate_branch)
                query += " AND " + branch_clause
                params.extend(branch_params)
            if branch_filter:
                branch_clause, branch_params = sql_branch_filter("j", branch_filter, include_unknown=True)
                query += " AND " + branch_clause
                params.extend(branch_params)

            if search:
                query += " AND (LOWER(j.title) LIKE LOWER(%s) OR LOWER(COALESCE(c.name,j.organization_name,'')) LIKE LOWER(%s) OR LOWER(j.description) LIKE LOWER(%s) OR LOWER(j.opportunity_category) LIKE LOWER(%s) OR EXISTS (SELECT 1 FROM job_skills x JOIN skills sk ON sk.id=x.skill_id WHERE x.job_id=j.id AND LOWER(sk.name) LIKE LOWER(%s)))"
                p = f"%{search}%"
                params.extend([p, p, p, p, p])

            for col, value in [("j.opportunity_category", category), ("j.job_type", job_type), ("j.work_mode", work_mode), ("j.paid_status", paid_status), ("j.experience_level", level)]:
                if value and value != "All":
                    query += f" AND {col} = %s"
                    params.append(value)

            if location:
                query += " AND LOWER(j.location) LIKE LOWER(%s)"
                params.append(f"%{location}%")

            if skill_filter:
                query += " AND EXISTS (SELECT 1 FROM job_skills sf JOIN skills ss ON ss.id=sf.skill_id WHERE sf.job_id=j.id AND ss.name ILIKE %s)"
                params.append(f"%{skill_filter}%")

            if deadline_before:
                query += " AND j.deadline <= %s::date"
                params.append(deadline_before)

            if source_filter == "ADMIN" or source_filter == "RECRUITER":
                query += " AND j.owner_type=%s"
                params.append(source_filter)
            elif source_filter:
                query += " AND j.source_classification=%s"
                params.append(source_filter)

            query += " GROUP BY j.id, c.id, score.job_id, score.total_weight, score.matched_weight, score.skill_breakdown"
            if minimum_match:
                query += " HAVING (CASE WHEN %s IS NULL OR COALESCE(score.total_weight,0)=0 THEN 0 ELSE ROUND(100.0*score.matched_weight/score.total_weight,1) END) >= %s"
                params.extend([candidate_id, minimum_match])
            query += f" ORDER BY {order_sql} LIMIT %s OFFSET %s"
            params.extend([limit, (page-1)*limit])

            cur.execute(query, tuple(params))
            jobs = clean_record(cur.fetchall())

        for job in jobs:
            job["skill_gap"] = analyze_skill_gap(job.get("required_skills") or [], candidate_skills)
            branches = job.get("eligible_branches") or []
            job["branch_eligibility"] = (
                classify_branch_eligibility(candidate_branch, branches)
            ) if session.get("role") == "user" else ("all_branches" if is_unrestricted(branches) else "restricted")
            if session.get("role") == "user":
                job["candidate_branch"] = candidate_branch

        return jsonify({"jobs": jobs, "page": page, "limit": limit, "has_more": len(jobs) == limit}), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@jobs_bp.route("/<int:job_id>", methods=["GET"])
def get_job(job_id):
    """Fetches single job details with required skills and company overview."""
    try:
        with get_db() as (conn, cur):
            cur.execute(
                """
                SELECT 
                    j.*, (j.deadline < CURRENT_DATE) AS is_expired,
                    CASE WHEN j.deadline IS NULL THEN NULL ELSE GREATEST(j.deadline-CURRENT_DATE,0) END AS days_remaining,
                    COALESCE(c.name,j.organization_name,'Platform curated') AS company_name,
                    c.description AS company_description,
                    c.industry,
                    c.website,
                    COALESCE(c.location,j.location) AS company_location,
                    COALESCE(
                        JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id', s.id, 
                                'name', s.name, 
                                'is_required', js.is_required, 
                                'min_proficiency', js.min_proficiency
                            )
                        ) FILTER (WHERE s.id IS NOT NULL), '[]'::json
                    ) AS required_skills
                FROM jobs j
                LEFT JOIN companies c ON c.id = j.company_id
                LEFT JOIN job_skills js ON js.job_id = j.id
                LEFT JOIN skills s ON s.id = js.skill_id
                WHERE j.id = %s AND j.is_archived=FALSE
                GROUP BY j.id, c.id;
                """,
                (job_id,)
            )
            job = clean_record(cur.fetchone())
            if not job:
                return jsonify({"error": "Job opening not found."}), 404
            if job.get("status") != "published" or (job.get("owner_type") != "ADMIN" and job.get("company_id") is None):
                return jsonify({"error": "This opportunity is unavailable."}), 404
            if job.get("owner_type") == "RECRUITER" and job.get("company_id") is not None:
                cur.execute("SELECT status FROM companies WHERE id=%s",(job["company_id"],))
                company_state=cur.fetchone()
                if not company_state or company_state["status"] != "approved":
                    return jsonify({"error":"This opportunity is unavailable."}),404
            if is_deadline_expired(cur, job.get("deadline")):
                return jsonify({"error": "This opportunity has expired and is no longer accepting applications.", "expired": True}), 410
            if session.get("role") == "user":
                cur.execute("SELECT id FROM candidate_profiles WHERE account_id=%s", (session.get("account_id"),))
                candidate = cur.fetchone()
                candidate_branch = get_candidate_branch(cur, candidate["id"]) if candidate else None
                job["candidate_branch"] = candidate_branch
                job["branch_eligibility"] = classify_branch_eligibility(candidate_branch, job.get("eligible_branches"))
                if candidate:
                    cur.execute("SELECT s.name FROM candidate_skills cs JOIN skills s ON s.id=cs.skill_id WHERE cs.candidate_id=%s", (candidate["id"],))
                    job["skill_gap"] = analyze_skill_gap(job.get("required_skills") or [], [row["name"] for row in cur.fetchall()])

        return jsonify({"job": job}), 200

    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500


@jobs_bp.route("/<int:job_id>/apply", methods=["POST"])
@role_required("user")
def apply_for_job(job_id):
    """
    Submits a candidate application for an active job.
    Enforces uniqueness, unexpired status, and audit history creation in a transaction.
    """
    account_id = session["account_id"]
    data = request.get_json() or {}
    resume_id = data.get("resume_id")
    cover_letter = data.get("cover_letter") or ""
    if not isinstance(cover_letter, str) or len(cover_letter) > 10000:
        return jsonify({"error": "Cover letter must be text with no more than 10,000 characters."}), 400
    cover_letter = cover_letter.strip()

    try:
        with get_db() as (conn, cur):
            # 1. Fetch candidate_id
            cur.execute("SELECT id FROM candidate_profiles WHERE account_id = %s;", (account_id,))
            cand = cur.fetchone()
            if not cand:
                return jsonify({"error": "Candidate profile not found."}), 404
            cand_id = cand["id"]
            candidate_branch = get_candidate_branch(cur, cand_id)

            # 2. Check job status and expiration
            cur.execute(
                "SELECT id,title,status,deadline,application_mode,application_url,owner_type,company_id,eligible_branches FROM jobs WHERE id=%s;",
                (job_id,)
            )
            job = cur.fetchone()
            if not job:
                return jsonify({"error": "Job opening does not exist."}), 404
            if job["status"] != "published":
                return jsonify({"error": "This job is not accepting applications at this time."}), 400
            if job["owner_type"] == "RECRUITER":
                cur.execute("SELECT status FROM companies WHERE id=%s",(job["company_id"],))
                company=cur.fetchone()
                if not company or company["status"] != "approved":
                    return jsonify({"error":"This opportunity is unavailable."}),404
            if is_deadline_expired(cur, job["deadline"]):
                return jsonify({"error": "The deadline for this job posting has expired."}), 400
            if classify_branch_eligibility(candidate_branch, job.get("eligible_branches")) == "not_eligible":
                return jsonify({"error": "Your education branch is not eligible for this opportunity.", "branch_ineligible": True}), 403
            if job.get("application_mode") == "external":
                return jsonify({"error":"This opportunity uses an external application link.","external_application":True,"application_url":job.get("application_url")}),409

            # 3. Check duplicate application
            cur.execute(
                "SELECT id, current_status FROM applications WHERE job_id = %s AND candidate_id = %s;",
                (job_id, cand_id)
            )
            if cur.fetchone():
                return jsonify({"error": "You have already submitted an application for this position."}), 409

            # 4. Resolve resume
            if resume_id is None or resume_id == "":
                cur.execute("SELECT id FROM resumes WHERE candidate_id = %s AND is_default = TRUE LIMIT 1;", (cand_id,))
                default_res = cur.fetchone()
                if default_res:
                    resume_id = default_res["id"]
                else:
                    cur.execute("SELECT id FROM resumes WHERE candidate_id = %s ORDER BY uploaded_at DESC LIMIT 1;", (cand_id,))
                    latest_res = cur.fetchone()
                    if latest_res:
                        resume_id = latest_res["id"]
            else:
                try:
                    resume_id = int(resume_id)
                    if resume_id < 1: raise ValueError
                except (TypeError, ValueError):
                    return jsonify({"error": "Choose a valid resume."}), 400
                cur.execute("SELECT id FROM resumes WHERE id = %s AND candidate_id = %s;", (resume_id, cand_id))
                if not cur.fetchone():
                    return jsonify({"error": "The selected resume does not belong to your account."}), 403

            # 5. Insert application
            cur.execute(
                """
                INSERT INTO applications (job_id, candidate_id, resume_id, cover_letter, current_status)
                VALUES (%s, %s, %s, %s, 'submitted')
                RETURNING id, applied_at;
                """,
                (job_id, cand_id, resume_id, cover_letter or None)
            )
            app_result = cur.fetchone()
            app_id = app_result["id"]

            # 6. Insert audit trail in application_status_history
            cur.execute(
                """
                INSERT INTO application_status_history (application_id, status, notes, changed_by)
                VALUES (%s, 'submitted', 'Candidate submitted initial application.', %s);
                """,
                (app_id, account_id)
            )

            cur.execute(
                """
                SELECT j.title, rp.account_id AS recruiter_account_id
                FROM jobs j
                LEFT JOIN recruiter_profiles rp ON rp.id=j.recruiter_id
                WHERE j.id=%s
                """,
                (job_id,),
            )
            notification_context = cur.fetchone()
            create_notification(
                cur, account_id, "application_submitted", app_id, job_id,
                notification_context["title"],
            )
            if notification_context["recruiter_account_id"] is not None:
                create_notification(
                    cur, notification_context["recruiter_account_id"], "new_applicant",
                    app_id, job_id, notification_context["title"],
                )

        return jsonify({
            "message": f"Successfully applied for '{job['title']}'!",
            "application_id": app_id
        }), 201

    except pg_errors.UniqueViolation:
        return jsonify({"error": "You have already submitted an application for this position."}), 409
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500
