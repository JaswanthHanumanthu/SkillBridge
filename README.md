# SkillBridge

**An intelligent career and opportunity platform connecting students with jobs, internships, hackathons, and skill-based opportunities.**

SkillBridge brings student profiles, skill matching, opportunity discovery, applications, and recruiter workflows into one platform. Recruiters manage company opportunities and applicants. Platform administrators curate and review opportunities from external organizations. Candidates can browse opportunities, save them, apply through SkillBridge where supported, or follow an official external registration link.

> SkillBridge currently has three roles: Candidate, Recruiter, and Platform Administrator. It does not provide separate accounts for colleges, event organizers, or other opportunity providers.

## Features

- **Candidate workspace:** profile, education, experience, skills, preferences, CV uploads, applications, saved opportunities, and dashboard.
- **Opportunity discovery:** browse and search jobs, internships, hackathons, and other administrator-curated opportunities.
- **Skill matches:** recommendations use candidate skills, preferences, and opportunity eligibility information.
- **Applications:** apply to supported opportunities, review application status and history, and withdraw where the workflow permits.
- **Recruiter workspace:** manage company opportunities, review applicants, and progress application statuses.
- **Platform administration:** review companies and recruiter-company links, curate opportunities, and inspect platform records and application activity.
- **Notifications:** in-app notifications for supported application and recruiter workflow events.
- **BridgeMate / SkillGuide:** curated FAQ answers with optional server-side Gemini fallback when configured. FAQ answers are stored in PostgreSQL; Gemini credentials are never needed in the browser.
- **Session security:** signed, HTTP-only browser sessions and role-based route authorization.

Opportunity availability, deadlines, eligibility, and application methods depend on the stored listing. Candidates should confirm external opportunities on their official source pages.

## Technology

| Area | Technology |
| --- | --- |
| Frontend | HTML, CSS, vanilla JavaScript |
| Backend | Python, FastAPI, Uvicorn, compatibility helpers for existing route handlers |
| Database | PostgreSQL, `psycopg2` connection pooling, SQL schema and ordered migrations |
| Authentication | Signed session cookies, password hashing, role checks |
| AI fallback | Google Gemini through the server-side `google-genai` SDK; optional configuration |
| Deployment | Render Python Web Service described by `render.yaml` |

## Architecture

```mermaid
flowchart LR
    Browser[Candidate, Recruiter, Admin browser]
    UI[HTML, CSS, vanilla JavaScript]
    API[FastAPI application and role-protected routes]
    DB[(PostgreSQL)]
    Files[Resume upload storage]
    FAQ[Curated FAQ records]
    Gemini[Gemini API, optional fallback]

    Browser --> UI
    UI -->|Same-origin /api requests with session cookie| API
    API --> DB
    API --> Files
    API --> FAQ
    API -. FAQ has no strong match and key is configured .-> Gemini
```

The API serves the frontend from the same application origin. Browser API calls use relative `/api/...` paths; a separate frontend API URL is not required for the current architecture.

## Project structure

```text
.
├── backend/
│   ├── routes/                 # Auth, candidate, recruiter, jobs, admin, chat, analytics
│   ├── __init__.py             # App factory, middleware, health and frontend routes
│   ├── config.py               # Environment configuration
│   ├── db.py                   # PostgreSQL connection pool
│   ├── session_middleware.py   # Signed browser sessions
│   └── bootstrap_admin.py      # Explicit platform-admin provisioning
├── database/
│   ├── migrations/             # Ordered PostgreSQL migrations 001–011
│   ├── schema.sql              # Base schema for an empty database
│   ├── seed.sql                 # Explicit local demo accounts and skills
│   ├── seed_opportunities.sql   # Fictional opportunities for local demos
│   └── seed_verified_hackathons_2026_11_22.sql # Dated, reviewed listing import
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── uploads/                    # Local resume storage; contents are ignored by Git
├── .env.example
├── render.yaml
├── requirements.txt
├── setup_db.py
└── README.md
```

## Requirements

- Python 3.11 (the Render Blueprint pins 3.11.11)
- PostgreSQL
- Git
- Optional: Google Gemini API key for BridgeMate fallback

## Run locally on Windows

From PowerShell, clone the repository and enter its directory:

```powershell
git clone <repository-url>
Set-Location .\SkillBridge
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit the ignored `.env` file with your local PostgreSQL connection and a unique secret. Generate a secret locally with:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Copy the generated value into `SECRET_KEY` in `.env`; do not put it in source code, screenshots, or Git. Use URL-encoded characters in `DATABASE_URL` if the PostgreSQL username or password contains reserved URL characters.

Start the application from the project root:

```powershell
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. FastAPI's interactive API documentation is at <http://127.0.0.1:8000/docs>.

## Environment variables

See [.env.example](.env.example) for the placeholder template. Never commit `.env` or replace the placeholders in `.env.example` with real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL URL, for example `postgresql://USER:PASSWORD@HOST:5432/skillbridge` |
| `SECRET_KEY` | Yes | Random session-signing key of at least 32 characters |
| `DEBUG` | No | Local development behavior; set to `0` in production |
| `PORT` | No | Local server port; Render supplies this in production |
| `SESSION_COOKIE_SECURE` | No | Set to `1` behind HTTPS; production config defaults it on when debug is off |
| `CORS_ORIGINS` | No | Comma-separated exact origins only if a separate frontend is introduced |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | No | Used only when explicitly running the admin bootstrap command |
| `GEMINI_API_KEY` | No | Server-side key for BridgeMate Gemini fallback |
| `GEMINI_MODEL` | No | Gemini model override; defaults to the model in `backend/config.py` |
| `BRIDGEMATE_FAQ_MATCH_THRESHOLD` | No | FAQ confidence threshold, from 60 to 100 |

## Database setup and migrations

### New, empty development database

Set `DATABASE_URL` to the intended local database. Run the initializer **only when the target database is empty**:

```powershell
python setup_db.py
```

The initializer creates the base schema and applies migration 001. It stops if it finds existing tables. It does not load demo records unless explicitly called with `--seed`:

```powershell
python setup_db.py --seed
```

`--seed` is for a disposable local demonstration only. It adds sample accounts and fictional opportunities; never use it for production or a database containing real records. The dated `database/seed_verified_hackathons_2026_11_22.sql` is a separate, optional listing import. Its records can become stale: review each official source, the current event status, and the SQL before running it. It is not part of schema setup or the migration sequence.

### Existing database

Do **not** run `setup_db.py` against an existing database. This project does not yet maintain a migration-history table or run migrations automatically. Inspect the target schema first, then apply only missing migrations in numeric order. Migration 001 is included in fresh-database setup; existing databases may need it if its changes are absent. Then review migrations 002 through 011:

1. `002_candidate_preferences.sql`
2. `003_recruiter_company_link_requests.sql`
3. `004_saved_jobs.sql`
4. `005_admin_curated_opportunities.sql`
5. `006_admin_external_deadline_optional.sql`
6. `007_application_workflow.sql`
7. `008_notifications.sql`
8. `009_catalog_current_availability_review.sql`
9. `010_chatbot_faq.sql`
10. `011_hackathon_event_details.sql`

Use `psql` with the connection details for the database you inspected, for example:

```powershell
psql -h localhost -p 5432 -U postgres -d skillbridge -W -v ON_ERROR_STOP=1 -f database/migrations/002_candidate_preferences.sql
```

Repeat for each migration that is confirmed missing. Migration 009 changes publication status for named administrator-curated records; review the SQL and its affected records before applying it. Migration 007 backfills prior application status where it can be inferred. The migrations do not drop tables, truncate data, or delete rows, but migrations that update rows or replace constraints still require review against the target database.

After the schema is ready, configure `ADMIN_USERNAME` and `ADMIN_PASSWORD` privately and explicitly provision a platform administrator if one does not already exist:

```powershell
python -m backend.bootstrap_admin
```

## API overview

All routes are served under `/api`. Authentication uses the signed session cookie; protected routes still enforce the user's role.

| Area | Example routes |
| --- | --- |
| Health | `GET /api/health`, `GET /api/health/database` |
| Authentication | `POST /api/auth/register/user`, `POST /api/auth/register/recruiter`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Jobs and hackathons | `GET /api/jobs`, `GET /api/jobs/{job_id}`, `GET /api/jobs/hackathons`, `POST /api/jobs/{job_id}/apply` |
| Candidate | `/api/candidate/profile`, `/api/candidate/preferences`, `/api/candidate/recommendations`, `/api/candidate/saved-jobs`, `/api/candidate/applications` |
| Recruiter | `/api/recruiter/jobs`, `/api/recruiter/applicants`, `/api/recruiter/applications/{app_id}/status` |
| Platform administration | `/api/developer/jobs`, `/api/developer/companies`, `/api/developer/users`, `/api/developer/applications` |
| Notifications | `/api/notifications`, `/api/notifications/unread-count`, `/api/notifications/read-all` |
| BridgeMate | `/api/chatbot/categories`, `/api/chatbot/questions`, `/api/chatbot/ask` |

The route handlers under `backend/routes/` are the source of truth for supported methods, request bodies, and authorization requirements.

## Opportunity workflows

- **Platform administrators** review and publish curated listings in the shared opportunity catalog. Source and eligibility data are stored with the listing where available.
- **Recruiters** create and manage company opportunities and review applicants for their company.
- **Candidates** discover active jobs and hackathons, review skill matches, save listings, apply through the platform when supported, or follow an external registration link.
- Closed, draft, expired, and external opportunities follow their respective lifecycle and application rules; publication does not guarantee that an external source is still accepting registrations.

## Render deployment

The root [render.yaml](render.yaml) describes a Python Web Service. Connect the repository in Render and review the Blueprint before creating the service. Its build and start commands are:

```text
pip install -r requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port $PORT
```

Configure `DATABASE_URL` for a production PostgreSQL service and a strong `SECRET_KEY`. The Blueprint sets `DEBUG=0`, uses secure cookies, configures `/api/health/database` as the health check, and generates the session secret. Add `GEMINI_API_KEY` as a private Render environment variable only if Gemini fallback is wanted. Keep the app and frontend on one origin; do not set `CORS_ORIGINS` unless a separate frontend is deployed.

CV files are stored on the service filesystem. The Blueprint mounts a persistent disk at `uploads/`; Render persistent disks require a paid service and attach to a single instance. For multi-instance scaling, move CV storage to an object-storage service first. `autoDeployTrigger` is off in the Blueprint; deployments remain a manual action.

Before the first production launch, create or select the production database, inspect its existing schema, and apply only the reviewed missing migrations. Do not run `setup_db.py --seed` in production. The health endpoint checks database connectivity, not migration completeness.

## Screenshots

Real screenshots can be added here after capturing the application. No sample screenshots are included.

<!-- Suggested future files: docs/screenshots/candidate-dashboard.png, docs/screenshots/browse-hackathons.png -->

## Future work

These are possible improvements, not claims about current functionality:

- Add migration tracking and a reviewed automated migration workflow.
- Move CV storage to object storage before enabling multiple service instances.
- Expand automated integration and end-to-end coverage against a disposable PostgreSQL database.
- Add verified organization publishing accounts in a future phase while retaining the current three roles until that work is approved.

## License

No license has been selected. All rights remain with the project owner unless a license is added.
