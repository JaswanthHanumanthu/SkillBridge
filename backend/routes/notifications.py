"""Authenticated notification center API."""

from backend.fastapi_compat import Blueprint, request, jsonify, session, current_app
from backend.db import get_db
from backend.utils import clean_record, login_required

notifications_bp = Blueprint("notifications", __name__, url_prefix="/api/notifications")


@notifications_bp.route("", methods=["GET"])
@login_required
def list_notifications():
    account_id = session["account_id"]
    filter_value = request.args.get("filter", "all").strip().lower()
    if filter_value not in {"all", "unread", "read"}:
        return jsonify({"error": "Filter must be all, unread, or read."}), 400
    try:
        limit = int(request.args.get("limit", "20"))
        offset = int(request.args.get("offset", "0"))
    except (TypeError, ValueError):
        return jsonify({"error": "Limit and offset must be whole numbers."}), 400
    if not 1 <= limit <= 50 or offset < 0:
        return jsonify({"error": "Limit must be between 1 and 50 and offset cannot be negative."}), 400

    try:
        with get_db() as (conn, cur):
            cur.execute(
                "SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id=%s AND is_read=FALSE",
                (account_id,),
            )
            unread_count = cur.fetchone()["count"]

            where = "recipient_user_id=%s"
            params = [account_id]
            if filter_value == "unread":
                where += " AND is_read=FALSE"
            elif filter_value == "read":
                where += " AND is_read=TRUE"
            cur.execute(f"SELECT COUNT(*) AS count FROM notifications WHERE {where}", tuple(params))
            total = cur.fetchone()["count"]
            cur.execute(
                f"""
                SELECT id, notification_type, title, message, related_application_id,
                       related_job_id, is_read, created_at, read_at
                FROM notifications
                WHERE {where}
                ORDER BY created_at DESC, id DESC
                LIMIT %s OFFSET %s
                """,
                tuple(params + [limit, offset]),
            )
            notifications = clean_record(cur.fetchall())
        return jsonify({
            "notifications": notifications,
            "unread_count": unread_count,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": offset + len(notifications) < total,
        }), 200
    except Exception:
        current_app.logger.exception("Notification list request failed")
        return jsonify({"error": "Unable to load notifications right now."}), 500


@notifications_bp.route("/unread-count", methods=["GET"])
@login_required
def unread_count():
    try:
        with get_db() as (conn, cur):
            cur.execute(
                "SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id=%s AND is_read=FALSE",
                (session["account_id"],),
            )
            count = cur.fetchone()["count"]
        return jsonify({"unread_count": count}), 200
    except Exception:
        current_app.logger.exception("Unread notification count request failed")
        return jsonify({"error": "Unable to load the unread count right now."}), 500


@notifications_bp.route("/<int:notification_id>/read", methods=["PUT"])
@login_required
def mark_notification_read(notification_id):
    try:
        with get_db() as (conn, cur):
            cur.execute(
                """
                UPDATE notifications
                SET is_read=TRUE, read_at=COALESCE(read_at, CURRENT_TIMESTAMP)
                WHERE id=%s AND recipient_user_id=%s
                RETURNING id, is_read, read_at
                """,
                (notification_id, session["account_id"]),
            )
            notification = clean_record(cur.fetchone())
            if not notification:
                return jsonify({"error": "Notification not found."}), 404
            cur.execute(
                "SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id=%s AND is_read=FALSE",
                (session["account_id"],),
            )
            count = cur.fetchone()["count"]
        return jsonify({"notification": notification, "unread_count": count}), 200
    except Exception:
        current_app.logger.exception("Mark notification read request failed")
        return jsonify({"error": "Unable to update this notification right now."}), 500


@notifications_bp.route("/read-all", methods=["PUT"])
@login_required
def mark_all_notifications_read():
    try:
        with get_db() as (conn, cur):
            cur.execute(
                """
                UPDATE notifications
                SET is_read=TRUE, read_at=CURRENT_TIMESTAMP
                WHERE recipient_user_id=%s AND is_read=FALSE
                """,
                (session["account_id"],),
            )
            updated_count = cur.rowcount
        return jsonify({"message": "All notifications marked as read.", "updated_count": updated_count, "unread_count": 0}), 200
    except Exception:
        current_app.logger.exception("Mark all notifications read request failed")
        return jsonify({"error": "Unable to update notifications right now."}), 500
