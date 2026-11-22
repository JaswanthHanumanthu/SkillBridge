"""Role-scoped, read-only analytics backed by current SkillBridge records."""

from backend.application_workflow import APPLICATION_STATUSES
from backend.branch_matching import get_candidate_branch, sql_branch_filter
from backend.db import get_db
from backend.fastapi_compat import Blueprint, current_app, jsonify, session
from backend.utils import clean_record, role_required

analytics_bp = Blueprint("analytics", __name__, url_prefix="/api/analytics")


def _status_counts(rows):
    counts = {status: 0 for status in APPLICATION_STATUSES}
    counts.update({row["current_status"]: row["count"] for row in rows})
    return [{"status": status, "count": count} for status, count in counts.items()]


@analytics_bp.route("/candidate", methods=["GET"])
@role_required("user")
def candidate_analytics():
    """Return application, activity, profile, and skill-gap aggregates for self."""
    account_id = session["account_id"]
    try:
        with get_db() as (_conn, cur):
            cur.execute("SELECT id, full_name, email, phone, bio FROM candidate_profiles WHERE account_id=%s", (account_id,))
            profile = cur.fetchone()
            if not profile:
                return jsonify({"error": "Candidate profile not found."}), 404
            candidate_id = profile["id"]

            cur.execute("""
                SELECT COUNT(*) AS total_applications,
                       COUNT(DISTINCT job_id) AS opportunities_applied_to,
                       COUNT(*) FILTER (WHERE current_status IN ('under_review','shortlisted','interview','selected','rejected')) AS reviewed_applications,
                       COUNT(*) FILTER (WHERE current_status IN ('shortlisted','interview','selected')) AS advanced_applications,
                       COUNT(*) FILTER (WHERE current_status='selected') AS selected_applications
                FROM applications WHERE candidate_id=%s
            """, (candidate_id,))
            summary = dict(cur.fetchone())
            cur.execute("SELECT current_status, COUNT(*) AS count FROM applications WHERE candidate_id=%s GROUP BY current_status", (candidate_id,))
            statuses = _status_counts(cur.fetchall())
            cur.execute("SELECT COUNT(*) AS count FROM saved_jobs WHERE candidate_id=%s", (candidate_id,))
            summary["saved_opportunities"] = cur.fetchone()["count"]

            cur.execute("""
                SELECT s.name, s.category, cs.proficiency
                FROM candidate_skills cs JOIN skills s ON s.id=cs.skill_id
                WHERE cs.candidate_id=%s ORDER BY s.name
            """, (candidate_id,))
            skills = clean_record(cur.fetchall())

            branch = get_candidate_branch(cur, candidate_id)
            branch_predicate, branch_params = sql_branch_filter("j", branch, include_unknown=True)
            cur.execute(f"""
                SELECT COUNT(DISTINCT j.id) AS matching_opportunities
                FROM jobs j LEFT JOIN companies c ON c.id=j.company_id
                WHERE j.status='published' AND (j.deadline IS NULL OR j.deadline>=CURRENT_DATE)
                  AND (j.owner_type='ADMIN' OR c.status='approved')
                  AND {branch_predicate}
            """, tuple(branch_params))
            matching_opportunities = cur.fetchone()["matching_opportunities"]
            cur.execute(f"""
                SELECT s.name, COUNT(DISTINCT j.id) AS opportunity_count
                FROM jobs j JOIN job_skills js ON js.job_id=j.id AND js.is_required=TRUE
                JOIN skills s ON s.id=js.skill_id
                LEFT JOIN companies c ON c.id=j.company_id
                WHERE j.status='published' AND (j.deadline IS NULL OR j.deadline>=CURRENT_DATE)
                  AND (j.owner_type='ADMIN' OR c.status='approved')
                  AND {branch_predicate}
                  AND NOT EXISTS (
                      SELECT 1 FROM candidate_skills cs
                      WHERE cs.candidate_id=%s AND cs.skill_id=js.skill_id
                  )
                GROUP BY s.id, s.name ORDER BY opportunity_count DESC, s.name LIMIT 8
            """, tuple(branch_params + [candidate_id]))
            skill_gaps = clean_record(cur.fetchall())

            cur.execute("""
                WITH months AS (
                    SELECT generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '5 months',
                                           date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS month_start
                ), activity AS (
                    SELECT date_trunc('month', applied_at) AS month_start, COUNT(*) AS count
                    FROM applications
                    WHERE candidate_id=%s AND applied_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
                    GROUP BY 1
                )
                SELECT to_char(months.month_start, 'Mon YY') AS month,
                       COALESCE(activity.count,0) AS count
                FROM months LEFT JOIN activity USING (month_start) ORDER BY months.month_start
            """, (candidate_id,))
            activity = clean_record(cur.fetchall())

            cur.execute("""
                SELECT
                  (full_name IS NOT NULL AND btrim(full_name)<>'' AND email IS NOT NULL AND btrim(email)<>''
                   AND phone IS NOT NULL AND btrim(phone)<>'' AND bio IS NOT NULL AND btrim(bio)<>'') AS basic_profile,
                  EXISTS(SELECT 1 FROM education WHERE candidate_id=%s) AS has_education,
                  EXISTS(SELECT 1 FROM candidate_skills WHERE candidate_id=%s) AS has_skills,
                  EXISTS(SELECT 1 FROM experience WHERE candidate_id=%s) AS has_experience,
                  EXISTS(SELECT 1 FROM achievements WHERE candidate_id=%s) AS has_achievements,
                  EXISTS(SELECT 1 FROM resumes WHERE candidate_id=%s) AS has_resume,
                  EXISTS(SELECT 1 FROM job_preferences WHERE candidate_id=%s AND preferred_role IS NOT NULL
                         AND preferred_location IS NOT NULL AND cardinality(preferred_categories)>0) AS has_preferences
                FROM candidate_profiles WHERE id=%s
            """, (candidate_id,) * 7)
            completion_row = cur.fetchone()
            completion_labels = [
                ("Basic profile", "basic_profile"), ("Education", "has_education"),
                ("Skills", "has_skills"), ("Experience", "has_experience"),
                ("Achievements", "has_achievements"), ("Resume", "has_resume"),
                ("Opportunity preferences", "has_preferences"),
            ]
            missing_sections = [label for label, key in completion_labels if not completion_row[key]]
            completion = round((len(completion_labels) - len(missing_sections)) * 100 / len(completion_labels))

        total = summary["total_applications"]
        funnel = [
            {"stage": "Applied", "count": total},
            {"stage": "Reviewed", "count": summary["reviewed_applications"]},
            {"stage": "Advanced", "count": summary["advanced_applications"]},
            {"stage": "Selected", "count": summary["selected_applications"]},
        ]
        return jsonify({
            "summary": summary, "application_statuses": statuses, "application_funnel": funnel,
            "skills": skills, "skill_gaps": skill_gaps,
            "matching_opportunities": matching_opportunities, "candidate_branch": branch,
            "profile_completeness": {"percentage": completion, "missing_sections": missing_sections},
            "application_activity": activity,
        }), 200
    except Exception:
        current_app.logger.exception("Candidate analytics request failed")
        return jsonify({"error": "Unable to load candidate analytics right now."}), 500


@analytics_bp.route("/recruiter", methods=["GET"])
@role_required("recruiter")
def recruiter_analytics():
    """Return aggregates for the authenticated recruiter's approved organization."""
    account_id = session["account_id"]
    try:
        with get_db() as (_conn, cur):
            cur.execute("""
                SELECT rp.company_id, c.status
                FROM recruiter_profiles rp JOIN companies c ON c.id=rp.company_id
                WHERE rp.account_id=%s
            """, (account_id,))
            recruiter = cur.fetchone()
            if not recruiter or recruiter["status"] != "approved":
                return jsonify({"error": "Approved recruiter organization required."}), 403
            company_id = recruiter["company_id"]
            cur.execute("""
                SELECT COUNT(DISTINCT j.id) AS total_listings,
                       COUNT(DISTINCT j.id) FILTER (WHERE j.status='published' AND (j.deadline IS NULL OR j.deadline>=CURRENT_DATE)) AS active_listings,
                       COUNT(DISTINCT a.id) AS total_applications,
                       COUNT(DISTINCT a.candidate_id) AS unique_applicants,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.current_status='shortlisted') AS shortlisted,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.current_status='interview') AS interviews,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.current_status='selected') AS selected,
                       COUNT(DISTINCT a.id) FILTER (WHERE a.current_status='rejected') AS rejected
                FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
                WHERE j.company_id=%s AND j.owner_type='RECRUITER'
            """, (company_id,))
            summary = dict(cur.fetchone())
            cur.execute("""
                SELECT a.current_status, COUNT(*) AS count FROM applications a
                JOIN jobs j ON j.id=a.job_id
                WHERE j.company_id=%s AND j.owner_type='RECRUITER'
                GROUP BY a.current_status
            """, (company_id,))
            statuses = _status_counts(cur.fetchall())
            cur.execute("""
                SELECT j.id AS job_id, j.title,
                       CASE WHEN j.status='published' AND j.deadline<CURRENT_DATE THEN 'expired' ELSE j.status END AS status,
                       COUNT(a.id) AS applicants,
                       COUNT(a.id) FILTER (WHERE a.current_status='shortlisted') AS shortlisted,
                       COUNT(a.id) FILTER (WHERE a.current_status='interview') AS interviews,
                       COUNT(a.id) FILTER (WHERE a.current_status='selected') AS selected,
                       COUNT(a.id) FILTER (WHERE a.current_status='rejected') AS rejected
                FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
                WHERE j.company_id=%s AND j.owner_type='RECRUITER'
                GROUP BY j.id ORDER BY applicants DESC, j.created_at DESC LIMIT 10
            """, (company_id,))
            listings = clean_record(cur.fetchall())
            cur.execute("""
                WITH months AS (
                    SELECT generate_series(date_trunc('month', CURRENT_DATE)-INTERVAL '5 months',
                                           date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS month_start
                ), activity AS (
                    SELECT date_trunc('month', a.applied_at) AS month_start, COUNT(*) AS count
                    FROM applications a JOIN jobs j ON j.id=a.job_id
                    WHERE j.company_id=%s AND j.owner_type='RECRUITER'
                      AND a.applied_at >= date_trunc('month', CURRENT_DATE)-INTERVAL '5 months'
                    GROUP BY 1
                )
                SELECT to_char(months.month_start,'Mon YY') AS month, COALESCE(activity.count,0) AS count
                FROM months LEFT JOIN activity USING (month_start) ORDER BY months.month_start
            """, (company_id,))
            activity = clean_record(cur.fetchall())
        return jsonify({"summary": summary, "application_statuses": statuses,
                        "listing_performance": listings, "application_activity": activity}), 200
    except Exception:
        current_app.logger.exception("Recruiter analytics request failed")
        return jsonify({"error": "Unable to load recruiter analytics right now."}), 500


@analytics_bp.route("/admin", methods=["GET"])
@role_required("developer")
def admin_analytics():
    """Return platform-wide counts and trends for authorized administrators."""
    try:
        with get_db() as (_conn, cur):
            cur.execute("""
                SELECT (SELECT COUNT(*) FROM accounts) AS total_users,
                       (SELECT COUNT(*) FROM accounts WHERE role='user') AS candidates,
                       (SELECT COUNT(*) FROM accounts WHERE role='recruiter') AS recruiters,
                       (SELECT COUNT(*) FROM accounts WHERE role='developer') AS administrators,
                       (SELECT COUNT(*) FROM companies) AS organizations,
                       (SELECT COUNT(*) FROM jobs) AS total_opportunities,
                       (SELECT COUNT(*) FROM jobs WHERE status='published' AND (deadline IS NULL OR deadline>=CURRENT_DATE)
                         AND (owner_type='ADMIN' OR company_id IN (SELECT id FROM companies WHERE status='approved'))) AS active_opportunities,
                       (SELECT COUNT(*) FROM applications) AS total_applications
            """)
            summary = dict(cur.fetchone())
            cur.execute("SELECT current_status, COUNT(*) AS count FROM applications GROUP BY current_status")
            statuses = _status_counts(cur.fetchall())
            cur.execute("""
                SELECT COALESCE(NULLIF(btrim(opportunity_category),''),'Uncategorized') AS category,
                       COUNT(*) AS count,
                       COUNT(*) FILTER (WHERE status='published' AND (deadline IS NULL OR deadline>=CURRENT_DATE)
                         AND (owner_type='ADMIN' OR company_id IN (SELECT id FROM companies WHERE status='approved'))) AS active_count
                FROM jobs GROUP BY 1 ORDER BY count DESC, category LIMIT 10
            """)
            categories = clean_record(cur.fetchall())
            cur.execute("""
                WITH months AS (
                    SELECT generate_series(date_trunc('month', CURRENT_DATE)-INTERVAL '5 months',
                                           date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS month_start
                ), growth AS (
                    SELECT date_trunc('month', created_at) AS month_start, COUNT(*) AS count
                    FROM accounts WHERE created_at >= date_trunc('month', CURRENT_DATE)-INTERVAL '5 months'
                    GROUP BY 1
                )
                SELECT to_char(months.month_start,'Mon YY') AS month, COALESCE(growth.count,0) AS count
                FROM months LEFT JOIN growth USING (month_start) ORDER BY months.month_start
            """)
            user_growth = clean_record(cur.fetchall())
        total = summary["total_applications"]
        funnel = [
            {"stage": "Applications", "count": total},
            {"stage": "Reviewed", "count": sum(row["count"] for row in statuses if row["status"] != "submitted")},
            {"stage": "Advanced", "count": sum(row["count"] for row in statuses if row["status"] in {"shortlisted", "interview", "selected"})},
            {"stage": "Selected", "count": next((row["count"] for row in statuses if row["status"] == "selected"), 0)},
        ]
        return jsonify({"summary": summary, "application_statuses": statuses,
                        "opportunity_categories": categories, "user_growth": user_growth,
                        "application_funnel": funnel}), 200
    except Exception:
        current_app.logger.exception("Platform analytics request failed")
        return jsonify({"error": "Unable to load platform analytics right now."}), 500
