"""FastAPI application factory for SkillBridge."""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.cors import CORSMiddleware

from backend.config import Config
from backend.db import init_db_pool, close_db_pool, get_db
from backend.fastapi_compat import abort
from backend.session_middleware import SignedSessionMiddleware

logger = logging.getLogger("skillbridge.api")


def create_app():
    frontend_dir = os.path.join(Config.BASE_DIR, "frontend")

    @asynccontextmanager
    async def lifespan(_app):
        init_db_pool()
        try:
            yield
        finally:
            close_db_pool()

    app = FastAPI(
        title="SkillBridge API",
        description="Student skills and opportunity matching platform API",
        version="1.0.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=Config.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )
    app.add_middleware(SignedSessionMiddleware, secret_key=Config.SECRET_KEY,
                       https_only=Config.SESSION_COOKIE_SECURE)

    from backend.routes.auth import auth_bp
    from backend.routes.candidate import candidate_bp
    from backend.routes.recruiter import recruiter_bp
    from backend.routes.developer import developer_bp
    from backend.routes.jobs import jobs_bp
    from backend.routes.skills import skills_bp
    from backend.routes.notifications import notifications_bp
    from backend.routes.analytics import analytics_bp
    from backend.routes.chatbot import chatbot_bp

    for router in (auth_bp, candidate_bp, recruiter_bp, developer_bp, jobs_bp, skills_bp, notifications_bp, analytics_bp, chatbot_bp):
        app.include_router(router)

    @app.get("/api/health")
    async def health_check():
        return {"status": "healthy", "framework": "FastAPI", "project": "SkillBridge", "database": "PostgreSQL"}

    @app.get("/api/health/database")
    async def database_health():
        try:
            with get_db() as (conn, cur): cur.execute("SELECT 1")
            return {"status": "healthy", "database": "PostgreSQL"}
        except Exception:
            logger.exception("Database health check failed")
            return JSONResponse({"status": "unavailable", "database": "PostgreSQL"}, status_code=503)

    @app.get("/uploads/resumes/{filename:path}")
    async def serve_uploaded_resume(filename: str, request: Request):
        from werkzeug.utils import secure_filename
        safe_name = secure_filename(filename)
        if not safe_name or safe_name != filename: raise HTTPException(status_code=404)
        account_id = request.scope.get("session", {}).get("account_id")
        if not account_id: raise HTTPException(status_code=401, detail="Authentication required.")
        with get_db() as (conn, cur):
            cur.execute("""
                SELECT r.id FROM resumes r JOIN candidate_profiles cp ON cp.id=r.candidate_id
                LEFT JOIN applications a ON a.resume_id=r.id
                LEFT JOIN jobs j ON j.id=a.job_id
                LEFT JOIN recruiter_profiles rp ON rp.account_id=%s AND rp.company_id=j.company_id
                WHERE r.file_path=%s AND (cp.account_id=%s OR rp.account_id=%s) LIMIT 1
            """, (account_id, f"uploads/resumes/{safe_name}", account_id, account_id))
            if not cur.fetchone(): raise HTTPException(status_code=404, detail="Resume not found.")
        file_path = os.path.join(Config.UPLOAD_FOLDER, safe_name)
        if not os.path.isfile(file_path): raise HTTPException(status_code=404, detail="Resume not found.")
        return FileResponse(file_path)

    @app.get("/")
    async def index():
        return FileResponse(os.path.join(frontend_dir, "index.html"))

    @app.get("/{path:path}")
    async def frontend_or_not_found(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        root = os.path.realpath(frontend_dir)
        candidate = os.path.realpath(os.path.join(root, path))
        if candidate.startswith(root + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(frontend_dir, "index.html"))

    @app.exception_handler(Exception)
    async def unhandled_exception(_request: Request, exc: Exception):
        logger.exception("Unhandled API error", exc_info=exc)
        return JSONResponse({"error": "An unexpected error occurred. Please try again later."}, status_code=500)

    return app
