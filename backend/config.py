import os
from urllib.parse import urlsplit
from dotenv import dotenv_values, load_dotenv

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(BASE_DIR, ".env")
_DOTENV_VALUES = dotenv_values(dotenv_path=ENV_FILE)
load_dotenv(dotenv_path=ENV_FILE, override=False)
_IS_DEBUG = os.getenv("DEBUG", "0").lower() in {"1", "true", "yes", "on"}


def _cors_origins():
    """Allow explicitly configured cross-origin frontends; same-origin needs none."""
    configured = [value.strip().rstrip("/") for value in os.getenv("CORS_ORIGINS", "").split(",") if value.strip()]
    if not configured and _IS_DEBUG:
        configured = [
            "http://localhost:8000", "http://127.0.0.1:8000",
            "http://localhost:5500", "http://127.0.0.1:5500",
            "http://localhost:5000", "http://127.0.0.1:5000",
        ]
    for origin in configured:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
            raise RuntimeError("CORS_ORIGINS must be a comma-separated list of HTTP(S) origins without paths.")
    return configured


def _has_url_password(value):
    if not value:
        return False
    try:
        password = urlsplit(value).password
        return password is not None and password != ""
    except ValueError:
        return False


def _database_url():
    """Prefer a complete project .env URL over a stale passwordless process URL."""
    process_url = os.getenv("DATABASE_URL")
    dotenv_url = _DOTENV_VALUES.get("DATABASE_URL")
    if dotenv_url and _has_url_password(dotenv_url) and not _has_url_password(process_url):
        return dotenv_url
    return process_url or dotenv_url


def _required_secret():
    secret = os.getenv("SECRET_KEY")
    if not secret or len(secret) < 32:
        raise RuntimeError("SECRET_KEY must be set to at least 32 characters in the environment or .env file.")
    return secret


class Config:
    BASE_DIR = BASE_DIR
    SECRET_KEY = _required_secret()
    DATABASE_URL = _database_url()
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL must be set in the environment or .env file.")
    DEBUG = _IS_DEBUG
    ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "").strip()
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
    GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip() or "gemini-3.8-flash"
    try:
        BRIDGEMATE_FAQ_MATCH_THRESHOLD = int(os.getenv("BRIDGEMATE_FAQ_MATCH_THRESHOLD", "68"))
    except ValueError as exc:
        raise RuntimeError("BRIDGEMATE_FAQ_MATCH_THRESHOLD must be an integer from 60 to 100.") from exc
    if not 60 <= BRIDGEMATE_FAQ_MATCH_THRESHOLD <= 100:
        raise RuntimeError("BRIDGEMATE_FAQ_MATCH_THRESHOLD must be an integer from 60 to 100.")
    GEMINI_TIMEOUT_MS = 20000
    GEMINI_MAX_OUTPUT_TOKENS = 500
    SESSION_COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "0" if DEBUG else "1").lower() in {"1", "true", "yes", "on"}
    CORS_ORIGINS = _cors_origins()
    UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads", "resumes")
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024
    ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "txt"}
