from backend.fastapi_compat import Blueprint, jsonify, current_app
from backend.db import get_db
from backend.utils import clean_record

skills_bp = Blueprint("skills", __name__, url_prefix="/api/skills")

@skills_bp.route("", methods=["GET"])
def get_all_skills():
    """Returns all master skills grouped by category for selection in forms."""
    try:
        with get_db() as (conn, cur):
            cur.execute("SELECT id, name, category FROM skills ORDER BY category ASC, name ASC;")
            skills = clean_record(cur.fetchall())
        return jsonify({"skills": skills}), 200
    except Exception:
        current_app.logger.exception("Request failed")
        return jsonify({"error": "An unexpected error occurred. Please try again later."}), 500
