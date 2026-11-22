"""BridgeMate: authenticated curated FAQ answers with Gemini fallback."""

import re
import threading
import time
import unicodedata
from collections import defaultdict, deque

from backend.db import get_db
from backend.gemini_service import (
    GeminiNotConfigured, GeminiTimedOut, GeminiUnavailable, generate_gemini_answer,
)
from backend.fastapi_compat import Blueprint, current_app, jsonify, request
from backend.config import Config
from backend.utils import clean_record, role_required

chatbot_bp = Blueprint("chatbot", __name__, url_prefix="/api/chatbot")

MAX_QUERY_LENGTH = 300
MAX_REQUESTS_PER_MINUTE = 30
_STOP_WORDS = {
    "a", "about", "am", "an", "and", "are", "as", "at", "be", "best", "can",
    "do", "for", "from", "get", "give", "how", "i", "in", "is", "it", "me", "my",
    "of", "on", "or", "please", "should", "show", "some", "tell", "that", "the",
    "to", "use", "using", "what", "which", "with", "would", "you", "your", "answer",
}
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS = defaultdict(deque)
_GEMINI_RATE_BUCKETS = defaultdict(deque)
GEMINI_MAX_PER_MINUTE = 6
GEMINI_MAX_PER_HOUR = 30


def _normalize(value):
    text = unicodedata.normalize("NFKC", str(value or "")).casefold().replace("&", " and ")
    tokens = re.findall(r"[a-z0-9]+(?:[+#.][a-z0-9+#.]*)*", text)
    aliases = {"behavior": "behavioral", "behaviour": "behavioral", "behavioural": "behavioral"}
    return " ".join(aliases.get(token, token) for token in tokens)


def _content_tokens(value):
    return {token for token in _normalize(value).split() if token not in _STOP_WORDS and len(token) > 1}


def _phrase_present(phrase, query):
    phrase_norm = _normalize(phrase)
    query_norm = _normalize(query)
    return bool(phrase_norm and f" {phrase_norm} " in f" {query_norm} ")


def _score_faq(query, item):
    """Return a conservative 0..100 relevance score for the FAQ record."""
    query_norm = _normalize(query)
    question_norm = _normalize(item.get("question"))
    if query_norm == question_norm:
        return 100

    keywords = item.get("keywords") or []
    if any(
        query_norm == _normalize(keyword) and len(_content_tokens(keyword)) >= 2
        for keyword in keywords
    ):
        return 96

    query_tokens = _content_tokens(query)
    if not query_tokens:
        return 0
    question_tokens = _content_tokens(item.get("question"))
    title_tokens = _content_tokens(item.get("title"))
    keyword_token_sets = [_content_tokens(keyword) for keyword in keywords]
    target_tokens = question_tokens | title_tokens
    for phrase_tokens in keyword_token_sets:
        target_tokens |= phrase_tokens

    if len(query_tokens) >= 3 and _phrase_present(query, item.get("question", "")):
        return 91
    if len(query_tokens) >= 3 and _phrase_present(item.get("question", ""), query):
        return 88
    if any(len(_content_tokens(keyword)) >= 2 and _phrase_present(keyword, query) for keyword in keywords):
        return 90

    overlap = query_tokens & target_tokens
    coverage = len(overlap) / len(query_tokens)
    question_coverage = len(query_tokens & question_tokens) / len(query_tokens)
    title_coverage = len(query_tokens & title_tokens) / len(query_tokens)
    keyword_coverage = max(
        (len(query_tokens & tokens) / len(query_tokens) for tokens in keyword_token_sets if tokens),
        default=0,
    )
    jaccard = len(query_tokens & question_tokens) / max(1, len(query_tokens | question_tokens))
    score = 0.44 * coverage + 0.19 * question_coverage + 0.17 * keyword_coverage + 0.12 * title_coverage + 0.08 * jaccard

    # A one-word prompt should not match merely because it is common in a question.
    if len(query_tokens) == 1:
        score *= 0.5
    return round(score * 100)


def _best_match(query, records):
    ranked = [(_score_faq(query, item), item) for item in records]
    return max(ranked, key=lambda pair: pair[0], default=(0, None))


def _allow_request(account_id):
    now = time.monotonic()
    with _RATE_LOCK:
        bucket = _RATE_BUCKETS[account_id]
        while bucket and now - bucket[0] >= 60:
            bucket.popleft()
        if len(bucket) >= MAX_REQUESTS_PER_MINUTE:
            return False
        bucket.append(now)
        if len(_RATE_BUCKETS) > 5000:
            stale = [key for key, values in _RATE_BUCKETS.items() if not values or now - values[-1] >= 60]
            for key in stale:
                _RATE_BUCKETS.pop(key, None)
    return True


def _allow_gemini_request(account_id):
    """Bound paid-provider use per candidate, per process."""
    now = time.monotonic()
    with _RATE_LOCK:
        bucket = _GEMINI_RATE_BUCKETS[account_id]
        while bucket and now - bucket[0] >= 3600:
            bucket.popleft()
        recent_minute = sum(now - stamp < 60 for stamp in bucket)
        if len(bucket) >= GEMINI_MAX_PER_HOUR or recent_minute >= GEMINI_MAX_PER_MINUTE:
            return False
        bucket.append(now)
        if len(_GEMINI_RATE_BUCKETS) > 5000:
            stale = [
                key for key, values in _GEMINI_RATE_BUCKETS.items()
                if not values or now - values[-1] >= 3600
            ]
            for key in stale:
                _GEMINI_RATE_BUCKETS.pop(key, None)
    return True


def _load_approved_faq(cur, category=None):
    sql = """
        SELECT faq_id, category, category_label, question, keywords, title, answer, quick_prompts
        FROM chatbot_faq WHERE review_status='approved'
    """
    params = []
    if category:
        sql += " AND category=%s"
        params.append(category)
    sql += " ORDER BY category, faq_id"
    cur.execute(sql, tuple(params))
    return clean_record(cur.fetchall())


def _safe_prompts(prompts, approved_records, exclude_id=None, limit=4):
    selected = []
    seen = set()
    for prompt in prompts or []:
        normalized = _normalize(prompt)
        if not normalized or normalized in seen:
            continue
        score, match = _best_match(prompt, approved_records)
        if score >= Config.BRIDGEMATE_FAQ_MATCH_THRESHOLD and match and match.get("faq_id") != exclude_id:
            selected.append(str(prompt).strip())
            seen.add(normalized)
        if len(selected) >= limit:
            break
    return selected


@chatbot_bp.route("/categories", methods=["GET"])
@role_required("user")
def categories():
    try:
        with get_db() as (_conn, cur):
            cur.execute("""
                SELECT category, MIN(category_label) AS category_label, COUNT(*) AS question_count
                FROM chatbot_faq WHERE review_status='approved'
                GROUP BY category ORDER BY MIN(category_label), category
            """)
            results = clean_record(cur.fetchall())
        return jsonify({"categories": results}), 200
    except Exception:
        current_app.logger.exception("BridgeMate category lookup failed")
        return jsonify({"error": "Career topics are unavailable right now."}), 500


@chatbot_bp.route("/questions", methods=["GET"])
@role_required("user")
def questions():
    category = request.args.get("category", "").strip()
    if len(category) > 50:
        return jsonify({"error": "Category must be 50 characters or fewer."}), 400
    try:
        with get_db() as (_conn, cur):
            records = _load_approved_faq(cur, category or None)
        prompts = []
        for item in records:
            prompts.extend(item.get("quick_prompts") or [])
        return jsonify({
            "questions": [{"id": item["faq_id"], "category": item["category"],
                           "category_label": item["category_label"], "question": item["question"],
                           "title": item["title"]} for item in records],
            "quick_prompts": _safe_prompts(prompts, records, limit=8),
        }), 200
    except Exception:
        current_app.logger.exception("BridgeMate question lookup failed")
        return jsonify({"error": "Career prompts are unavailable right now."}), 500


@chatbot_bp.route("/ask", methods=["POST"])
@role_required("user")
def ask():
    body = request.get_json() or {}
    query = body.get("query")
    if not isinstance(query, str):
        return jsonify({"error": "Enter a career question as text."}), 400
    query = query.strip()
    if not query:
        return jsonify({"error": "Enter a career question before sending."}), 400
    if len(query) > MAX_QUERY_LENGTH:
        return jsonify({"error": f"Questions must be {MAX_QUERY_LENGTH} characters or fewer."}), 400
    account_id = request.raw.scope.get("session", {}).get("account_id")
    if not _allow_request(account_id):
        return jsonify({"error": "You have reached the question limit. Please try again in a minute."}), 429

    try:
        with get_db() as (_conn, cur):
            records = _load_approved_faq(cur)
        score, match = _best_match(query, records)
        if match and score >= Config.BRIDGEMATE_FAQ_MATCH_THRESHOLD:
            return jsonify({
                "matched": True,
                "mode": "faq",
                "faq_id": match["faq_id"],
                "title": match["title"],
                "answer": match["answer"],
                "category": match["category"],
                "category_label": match["category_label"],
                "quick_prompts": _safe_prompts(
                    match.get("quick_prompts"), records, exclude_id=match["faq_id"], limit=4
                ),
                "score": score,
            }), 200

        suggestions = _safe_prompts(
            [item.get("question") for item in records], records, limit=4
        )
        if not Config.GEMINI_API_KEY:
            return jsonify({
                "mode": "error",
                "code": "gemini_not_configured",
                "error": "SkillGuide AI fallback is not configured yet. Add GEMINI_API_KEY to your local .env file.",
                "quick_prompts": suggestions,
            }), 503
        if not _allow_gemini_request(account_id):
            return jsonify({
                "mode": "error",
                "code": "gemini_rate_limited",
                "error": "SkillGuide has reached its AI question limit. Please try again later or choose a reviewed prompt.",
                "quick_prompts": suggestions,
            }), 429

        try:
            answer = generate_gemini_answer(query)
        except GeminiNotConfigured:
            return jsonify({
                "mode": "error", "code": "gemini_not_configured",
                "error": "SkillGuide AI fallback is not configured yet. Add GEMINI_API_KEY to your local .env file.",
                "quick_prompts": suggestions,
            }), 503
        except GeminiTimedOut:
            return jsonify({
                "mode": "error", "code": "gemini_timeout",
                "error": "SkillGuide AI took too long to respond. Please retry or choose a reviewed prompt.",
                "quick_prompts": suggestions,
            }), 504
        except GeminiUnavailable:
            current_app.logger.warning("SkillGuide Gemini provider request failed.")
            return jsonify({
                "mode": "error", "code": "gemini_unavailable",
                "error": "SkillGuide AI is temporarily unavailable. Please retry or choose a reviewed prompt.",
                "quick_prompts": suggestions,
            }), 503

        return jsonify({
            "matched": False,
            "mode": "gemini",
            "title": "SkillGuide AI guidance",
            "answer": answer,
            "category": None,
            "category_label": None,
            "quick_prompts": suggestions,
            "score": score,
        }), 200
    except Exception:
        current_app.logger.exception("BridgeMate FAQ request failed")
        return jsonify({"error": "BridgeMate could not search its reviewed FAQs right now."}), 500


@chatbot_bp.route("/review", methods=["GET"])
@role_required("developer")
def review_queue():
    """Allow platform admins to inspect content withheld pending review."""
    try:
        with get_db() as (_conn, cur):
            cur.execute("""
                SELECT faq_id, category, category_label, question, title, answer,
                       review_status, review_notes
                FROM chatbot_faq WHERE review_status='needs_review'
                ORDER BY category, faq_id
            """)
            records = clean_record(cur.fetchall())
        return jsonify({"faqs": records}), 200
    except Exception:
        current_app.logger.exception("BridgeMate FAQ review queue failed")
        return jsonify({"error": "FAQ review items are unavailable right now."}), 500


@chatbot_bp.route("/review", methods=["PATCH"])
@role_required("developer")
def update_review_status():
    body = request.get_json() or {}
    faq_id = body.get("faq_id")
    review_status = body.get("review_status")
    review_notes = body.get("review_notes")
    if not isinstance(faq_id, str) or not re.fullmatch(r"q[0-9]{1,3}", faq_id):
        return jsonify({"error": "A valid FAQ id is required."}), 400
    if not isinstance(review_status, str) or review_status not in {"approved", "needs_review"}:
        return jsonify({"error": "Review status must be approved or needs_review."}), 400
    if review_notes is not None and (not isinstance(review_notes, str) or len(review_notes) > 1000):
        return jsonify({"error": "Review notes must be text of 1,000 characters or fewer."}), 400
    try:
        with get_db() as (_conn, cur):
            cur.execute("""
                UPDATE chatbot_faq SET review_status=%s, review_notes=%s
                WHERE faq_id=%s
                RETURNING faq_id, review_status, review_notes
            """, (review_status, review_notes.strip() if review_notes else None, faq_id))
            updated = clean_record(cur.fetchone())
        if not updated:
            return jsonify({"error": "FAQ item not found."}), 404
        return jsonify({"faq": updated}), 200
    except Exception:
        current_app.logger.exception("BridgeMate FAQ review update failed")
        return jsonify({"error": "FAQ review status could not be updated."}), 500
