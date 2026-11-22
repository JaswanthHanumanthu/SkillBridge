import os
import sys
import psycopg2
from psycopg2 import sql
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT, parse_dsn
from dotenv import load_dotenv

load_dotenv()

APP_TABLES = {
    "accounts", "candidate_profiles", "companies", "recruiter_profiles", "skills",
    "candidate_skills", "education", "experience", "achievements", "resumes",
    "job_preferences", "jobs", "job_skills", "applications", "application_status_history", "notifications",
}


def get_connection_details():
    db_url = os.getenv("DATABASE_URL")
    if db_url and "YOUR_PASSWORD" not in db_url:
        # Use libpq's parser so percent-encoded credentials are decoded exactly
        # as they are when psycopg2 receives the connection URL directly.
        parsed = parse_dsn(db_url)
        return {
            "host": parsed.get("host", "localhost"),
            "port": int(parsed.get("port", 5432)),
            "user": parsed.get("user", "postgres"),
            "password": parsed.get("password", ""),
            "dbname": parsed.get("dbname", "jobportal_db"),
        }

    print("PostgreSQL connection details (password is not displayed).")
    return {
        "host": input("PostgreSQL Host [localhost]: ").strip() or "localhost",
        "port": int(input("PostgreSQL Port [5432]: ").strip() or "5432"),
        "user": input("PostgreSQL User [postgres]: ").strip() or "postgres",
        "password": input("PostgreSQL Password: ").strip(),
        "dbname": input("Database Name [jobportal_db]: ").strip() or "jobportal_db",
    }


def main():
    parser_seed = "--seed" in sys.argv[1:]
    creds = get_connection_details()
    try:
        server = psycopg2.connect(dbname="postgres", **{k: v for k, v in creds.items() if k != "dbname"})
        server.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cur = server.cursor()
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s;", (creds["dbname"],))
        if not cur.fetchone():
            cur.execute(sql.SQL("CREATE DATABASE {};").format(sql.Identifier(creds["dbname"])))
            print("Created empty database.")
        cur.close()
        server.close()

        conn = psycopg2.connect(**creds)
        cur = conn.cursor()
        cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public';")
        existing = {row[0] for row in cur.fetchall()}
        app_existing = existing & APP_TABLES
        if app_existing:
            raise RuntimeError(
                "SkillBridge tables already exist; no schema or seed changes were made. "
                "Use a reviewed migration for existing databases. Tables found: " + ", ".join(sorted(app_existing))
            )
        if existing:
            raise RuntimeError(
                "The database is not empty. No schema or seed changes were made. "
                "Choose a fresh database or create a reviewed migration."
            )

        schema_path = os.path.join(os.path.dirname(__file__), "database", "schema.sql")
        with open(schema_path, encoding="utf-8") as f:
            cur.execute(f.read())
        migration_path = os.path.join(os.path.dirname(__file__), "database", "migrations", "001_opportunity_discovery.sql")
        with open(migration_path, encoding="utf-8") as f:
            cur.execute(f.read())
        conn.commit()
        print("Created the SkillBridge schema in the empty database.")

        if parser_seed:
            seed_path = os.path.join(os.path.dirname(__file__), "database", "seed.sql")
            with open(seed_path, encoding="utf-8") as f:
                cur.execute(f.read())
            conn.commit()
            demo_path = os.path.join(os.path.dirname(__file__), "database", "seed_opportunities.sql")
            with open(demo_path, encoding="utf-8") as f:
                cur.execute(f.read())
            conn.commit()
            print("Loaded demo seed data (explicit --seed option).")
        else:
            print("No seed data loaded. Run `python setup_db.py --seed` only for a fresh demo install.")
        cur.close()
        conn.close()
        print("Database setup complete. Configure DATABASE_URL and SECRET_KEY in your environment/.env.")
    except Exception as exc:
        print("Setup stopped safely; no existing tables were changed. Check PostgreSQL availability and setup configuration.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
